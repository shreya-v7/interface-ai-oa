import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { Budget, type Rates } from './budget.js';
import { writeEvent } from '../policy/events.js';

export interface ModelReply {
  decision: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
/**
 * The only models discovery may call, with their us-east-1 on-demand USD rates per
 * million tokens. Nova rates come from the public AWS price list (AmazonBedrock offer,
 * us-east-1 regional rates, published 2026-10-06; Nova Premier is end-of-life).
 * Adding a model means adding its reviewed rate here.
 */
export const MODEL_RATES: Record<string, Rates> = {
  'us.openai.gpt-6.1-sol': { inputPerMillion: 2.2, outputPerMillion: 11 },
  'us.amazon.nova-2-lite-v1:0': { inputPerMillion: 0.33, outputPerMillion: 2.75 },
  'us.amazon.nova-pro-v1:0': { inputPerMillion: 0.8, outputPerMillion: 3.2 },
};
type Auth = 'bearer' | 'sigv4';
interface ConverseReply {
  output?: { message?: { content?: Array<{ toolUse?: { name?: string; input?: unknown } }> } };
  usage?: { inputTokens?: number; outputTokens?: number };
}
export class BedrockDiscoveryClient {
  readonly model: string;
  readonly region: string;
  readonly auth: Auth;
  readonly rates: Rates;
  calls = 0;
  private sdk?: BedrockRuntimeClient;
  constructor(
    readonly options: {
      budget?: Budget;
      journalPath?: string;
      runId: string;
      model?: string;
      region?: string;
      auth?: Auth;
    },
  ) {
    this.model = options.model ?? process.env.BEDROCK_MODEL ?? 'us.openai.gpt-6.1-sol';
    this.region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
    const rates = MODEL_RATES[this.model];
    if (this.region !== 'us-east-1' || !rates) throw new Error('UNBUDGETED_PROVIDER_CONFIGURATION');
    this.rates = rates;
    // Bearer API keys can be denied by organization policy; SigV4 uses the standard AWS
    // credential chain (environment, shared profile, SSO) instead.
    const auth = options.auth ?? process.env.BEDROCK_AUTH;
    if (auth !== undefined && auth !== 'bearer' && auth !== 'sigv4')
      throw new Error('UNKNOWN_BEDROCK_AUTH');
    this.auth = auth ?? (process.env.AWS_BEARER_TOKEN_BEDROCK ? 'bearer' : 'sigv4');
  }
  async decide(
    system: string,
    prompt: string,
    schema: Record<string, unknown>,
  ): Promise<ModelReply> {
    const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (this.auth === 'bearer' && !token) throw new Error('BEDROCK_TOKEN_REQUIRED');
    const maxTokens = 1800;
    // Bedrock requires an object at the top of a tool schema, while a discriminated
    // union is `oneOf`. Wrap it in one required property and unwrap the reply.
    const { $schema: _, ...decisionSchema } = schema;
    const body = {
      system: [{ text: system }],
      messages: [{ role: 'user' as const, content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'decide',
              description:
                'Choose one grounded UI action, checkpoint, finish, or human intervention.',
              inputSchema: {
                json: {
                  type: 'object',
                  properties: { decision: decisionSchema },
                  required: ['decision'],
                  additionalProperties: false,
                },
              },
            },
          },
        ],
        toolChoice: { tool: { name: 'decide' } },
      },
    };
    const serialized = JSON.stringify(body);
    const budget =
      this.options.budget ??
      new Budget('.runs/model-budget.json', Number(process.env.DISCOVERY_BUDGET_USD ?? 3));
    // Text-only observations: UTF-8 bytes plus protocol allowance conservatively
    // bound tokenized text. Images are deliberately excluded from this budget.
    const reservation = await budget.reserve(
      Buffer.byteLength(serialized) + 4096,
      maxTokens,
      this.rates,
    );
    this.calls++;
    await writeEvent(this.options.journalPath, {
      runId: this.options.runId,
      type: 'model_request',
      model: this.model,
      count: this.calls,
    });
    const data =
      this.auth === 'bearer'
        ? await this.sendBearer(serialized, token!)
        : await this.sendSigV4(body);
    const inputTokens = data.usage?.inputTokens;
    const outputTokens = data.usage?.outputTokens;
    if (inputTokens === undefined || outputTokens === undefined)
      throw new Error('BEDROCK_USAGE_MISSING_RESERVATION_RETAINED');
    const costUsd = await budget.settle(reservation, inputTokens, outputTokens, this.rates);
    await writeEvent(this.options.journalPath, {
      runId: this.options.runId,
      type: 'model_usage',
      model: this.model,
      inputTokens,
      outputTokens,
      costUsd,
    });
    const decisions =
      data.output?.message?.content?.filter((c) => c.toolUse?.name === 'decide') ?? [];
    if (decisions.length !== 1) throw new Error('EXPECTED_ONE_MODEL_DECISION');
    const input = decisions[0]!.toolUse!.input as { decision?: unknown } | undefined;
    return { decision: input?.decision, inputTokens, outputTokens, costUsd };
  }
  private async sendBearer(serialized: string, token: string): Promise<ConverseReply> {
    let response: Response;
    try {
      response = await fetch(
        `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.model)}/converse`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: serialized,
          signal: AbortSignal.timeout(90_000),
        },
      );
    } catch {
      throw new Error('BEDROCK_REQUEST_FAILED_RESERVATION_RETAINED');
    }
    if (!response.ok) throw new Error(`BEDROCK_HTTP_${response.status}_RESERVATION_RETAINED`);
    return (await response.json()) as ConverseReply;
  }
  private async sendSigV4(body: {
    system: Array<{ text: string }>;
    messages: Array<{ role: 'user'; content: Array<{ text: string }> }>;
    inferenceConfig: { maxTokens: number };
    toolConfig: unknown;
  }): Promise<ConverseReply> {
    // No SDK retries: a retried request could be billed twice outside the ledger.
    this.sdk ??= new BedrockRuntimeClient({ region: this.region, maxAttempts: 1 });
    try {
      return (await this.sdk.send(
        new ConverseCommand({
          modelId: this.model,
          ...body,
          toolConfig: body.toolConfig as never,
        }),
        { abortSignal: AbortSignal.timeout(90_000) },
      )) as ConverseReply;
    } catch (error) {
      // Provider messages can echo request content; keep only the exception class name.
      const name = (error as { name?: string }).name ?? 'Error';
      throw new Error(
        `BEDROCK_${/^[A-Za-z]{1,64}$/.test(name) ? name : 'Error'}_RESERVATION_RETAINED`,
      );
    }
  }
}
