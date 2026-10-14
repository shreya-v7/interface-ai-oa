import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type ElementHandle,
  type JSHandle,
  type Locator,
  type Page,
} from 'playwright';
import type {
  Action,
  Anchor,
  Inputs,
  Observation,
  Predicate,
  Profile,
  Target,
  UiElement,
  Value,
} from '../schema/index.js';
import { SessionController } from '../control/session.js';
import { authorizeAction, allowedUrl, PolicyError } from '../policy/gate.js';
import { installNetworkGuard, type NetworkStats } from '../policy/network-guard.js';
import { writeEvent } from '../policy/events.js';
import { formatMinor } from '../schema/money.js';

const CANDIDATES =
  'input,select,textarea,button,a,[role],h1,h2,h3,h4,label,p,legend,th,td,span,strong,b,summary';
export class SurfaceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'SurfaceError';
  }
}
export function valueOf(value: Value, inputs: Inputs): string {
  if ('const' in value) return String(value.const);
  const result = inputs[value.input];
  if (result === undefined) throw new SurfaceError('MISSING_INPUT');
  return value.format === 'minor_to_decimal' ? formatMinor(result) : String(result);
}
export function alias(text: string, profile: Profile): string {
  if (!text.startsWith('@')) return text;
  const key = text.slice(1);
  return profile.labelAliases[key] ?? profile.labelAliases[key.replace(/^label\./, '')] ?? text;
}
function aliasName(text: string, profile: Profile): string {
  const found = Object.entries(profile.labelAliases).find(([, value]) => value === text);
  return found ? `@${found[0].startsWith('label.') ? found[0] : `label.${found[0]}`}` : text;
}
interface Scanned extends UiElement {
  domIndex: number;
  node: () => Promise<ElementHandle<HTMLElement>>;
}
export interface SurfaceMetrics {
  actionCount: number;
  /** Automation actions that passed the policy gate but still triggered a network block. */
  unsafeDispatch: number;
  actionSequence: string[];
}
export interface WebSurfaceOptions {
  session?: SessionController;
  journalPath?: string;
  /** Column headers (vendor keys like `@memberId`) whose cell keys a table row. */
  rowKeyLabels?: string[];
}

export class WebSurface {
  readonly session: SessionController;
  readonly ready: Promise<NetworkStats>;
  readonly metrics: SurfaceMetrics = {
    actionCount: 0,
    unsafeDispatch: 0,
    actionSequence: [],
  };
  readonly drift: string[] = [];
  observation?: Observation;
  network?: NetworkStats;
  private refs = new Map<string, Scanned>();
  private snapshots = new Map<Frame, JSHandle>();
  private generation = 0;
  private recorderReady: Promise<void>;
  constructor(
    readonly page: Page,
    readonly profile: Profile,
    readonly options: WebSurfaceOptions = {},
  ) {
    this.session = options.session ?? new SessionController(undefined, options.journalPath);
    this.ready = installNetworkGuard(
      page.context(),
      profile,
      this.session.runId,
      options.journalPath,
    ).then(async (stats) => {
      // tsx preserves function names with __name inside serialized callbacks.
      // The browser has no Node closure; this identity helper changes no UI logic.
      const helper = 'globalThis.__name ??= (fn) => fn;';
      await page.context().addInitScript({ content: helper });
      await Promise.all(page.frames().map((frame) => frame.evaluate(helper).catch(() => {})));
      this.network = stats;
      return stats;
    });
    this.recorderReady = this.installRecorder();
    page.on('framenavigated', () => {
      this.refs.clear();
    });
    page.on('framedetached', (frame) => {
      void this.snapshots
        .get(frame)
        ?.dispose()
        .catch(() => {});
      this.snapshots.delete(frame);
    });
  }
  private framePath(frame: Frame): string[] {
    const path: string[] = [];
    let cursor: Frame | null = frame;
    while (cursor?.parentFrame()) {
      const actual = cursor.name();
      path.unshift(
        Object.entries(this.profile.frameAliases).find(([, v]) => v === actual)?.[0] ?? actual,
      );
      cursor = cursor.parentFrame();
    }
    return path;
  }
  private locateFrame(path: string[]): Frame {
    let current = this.page.mainFrame();
    for (const name of path) {
      const actual = this.profile.frameAliases[name] ?? name;
      const matches = current.childFrames().filter((frame) => frame.name() === actual);
      if (matches.length !== 1)
        throw new SurfaceError(matches.length ? 'AMBIGUOUS_FRAME' : 'FRAME_NOT_FOUND');
      current = matches[0]!;
    }
    return current;
  }
  private async scanFrame(frame: Frame, observationId: string): Promise<Scanned[]> {
    if (frame.url() !== 'about:blank' && !allowedUrl(frame.url(), this.profile)) return [];
    const snapshot = await frame.evaluateHandle(
      ({ selector, rowKeyHeaders }) => {
        const norm = (value: string | null | undefined) =>
          (value ?? '').replace(/\s+/g, ' ').trim();
        const all = Array.from(document.querySelectorAll<HTMLElement>(selector));
        const isControl = (el: HTMLElement) =>
          el.matches('input,select,textarea,button,a,summary,[role="button"],[role="link"]');
        const visible = (el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        return all.flatMap((el, index) => {
          if (!visible(el) || el.matches('input[type="hidden"]')) return [];
          if (el.parentElement?.closest('button,a,[role="button"],[role="link"]')) return [];
          const text = norm(el.textContent);
          if (!isControl(el) && !el.matches('[role="dialog"],[role="alertdialog"]')) {
            if (!text) return [];
            if (el.querySelector('input,select,textarea,button,a')) return [];
            if (
              Array.from(el.querySelectorAll<HTMLElement>(selector)).some(
                (child) => visible(child) && norm(child.textContent) === text,
              )
            )
              return [];
          }
          const tag = el.tagName.toLowerCase();
          const type =
            el instanceof HTMLInputElement
              ? el.type
              : el instanceof HTMLButtonElement
                ? el.type
                : undefined;
          let role =
            el.getAttribute('role') ??
            (
              {
                input:
                  type === 'submit' || type === 'button'
                    ? 'button'
                    : type === 'number'
                      ? 'spinbutton'
                      : 'textbox',
                select: 'combobox',
                textarea: 'textbox',
                button: 'button',
                a: 'link',
                h1: 'heading',
                h2: 'heading',
                h3: 'heading',
                h4: 'heading',
                th: 'columnheader',
              } as Record<string, string>
            )[tag] ??
            'text';
          const control = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
          const labels =
            'labels' in control && control.labels
              ? Array.from(control.labels)
                  .map((l) => norm(l.textContent))
                  .filter(Boolean)
              : [];
          const aria = norm(el.getAttribute('aria-label'));
          const labelledby = el
            .getAttribute('aria-labelledby')
            ?.split(/\s+/)
            .map((id) => norm(document.getElementById(id)?.textContent))
            .join(' ');
          const row = el.closest('tr');
          const cells = row ? Array.from(row.children).filter((n) => n.matches('td,th')) : [];
          const containingCell = el.closest('td,th');
          const cellIndex = containingCell ? cells.indexOf(containingCell) : -1;
          const previous = cellIndex > 0 ? norm(cells[cellIndex - 1]?.textContent) : '';
          const label =
            aria ||
            norm(labelledby) ||
            labels[0] ||
            (role === 'textbox' || role === 'combobox' || role === 'spinbutton' ? previous : '');
          const parentPrefix = el.parentElement
            ? norm(
                Array.from(el.parentElement.childNodes)
                  .filter((n) => n.nodeType === Node.TEXT_NODE)
                  .map((n) => n.textContent)
                  .join(' '),
              ).replace(/:\s*$/, '')
            : '';
          const near = previous || norm(el.previousElementSibling?.textContent) || parentPrefix;
          const name =
            label || (role === 'button' && el instanceof HTMLInputElement ? el.value : text);
          let tableRow: { header: string; key: string; name: string } | undefined;
          if (row && role === 'link') {
            const table = row.closest('table');
            const headers = table
              ? Array.from(table.querySelectorAll('tr')).find((r) => r.querySelector('th'))
              : undefined;
            const headingCells = headers ? Array.from(headers.children) : [];
            const index = headingCells.findIndex((h) =>
              rowKeyHeaders.includes(norm(h.textContent)),
            );
            if (index >= 0 && cells[index])
              tableRow = {
                header: norm(headingCells[index]?.textContent),
                key: norm(cells[index]?.textContent),
                name,
              };
          }
          const options =
            el instanceof HTMLSelectElement
              ? Array.from(el.options).map((o) => ({ label: norm(o.textContent), value: o.value }))
              : undefined;
          const value =
            el instanceof HTMLInputElement ||
            el instanceof HTMLSelectElement ||
            el instanceof HTMLTextAreaElement
              ? el.value
              : undefined;
          return [
            {
              node: el,
              index,
              role,
              name,
              text,
              tag,
              type,
              label: label || undefined,
              near: near || undefined,
              value,
              href: el instanceof HTMLAnchorElement ? el.href : undefined,
              formMethod: role === 'button' ? (el.closest('form')?.method ?? undefined) : undefined,
              row: tableRow,
              options,
            },
          ];
        });
      },
      {
        selector: CANDIDATES,
        rowKeyHeaders: (this.options.rowKeyLabels ?? [])
          .map((label) => alias(label, this.profile))
          .filter(Boolean),
      },
    );
    // Keep the exact scanned nodes. Positional locators can silently select a
    // different same-tag control after a DOM insertion or replacement.
    const previous = this.snapshots.get(frame);
    this.snapshots.set(frame, snapshot);
    await previous?.dispose().catch(() => {});
    const records = await snapshot.evaluate((rows) => rows.map(({ node: _, ...record }) => record));
    const path = this.framePath(frame);
    return records.map((record, position) => {
      const anchors: Anchor[] = [];
      if (record.label) anchors.push({ by: 'label', text: aliasName(record.label, this.profile) });
      if (record.role !== 'text')
        anchors.push({ by: 'role', role: record.role, name: aliasName(record.name, this.profile) });
      if (record.row)
        anchors.push({
          by: 'tableRow',
          header: aliasName(record.row.header, this.profile),
          key: { const: record.row.key },
          name: aliasName(record.row.name, this.profile),
        });
      if (record.near) anchors.push({ by: 'near', text: aliasName(record.near, this.profile) });
      if (!anchors.length || (!record.label && !record.row))
        anchors.push({ by: 'text', text: aliasName(record.text, this.profile) });
      const { index, ...fields } = record;
      return {
        ...fields,
        ref: `${observationId}_${path.join('_') || 'root'}_${index}`,
        frame: path,
        anchors: anchors.slice(0, 4),
        domIndex: index,
        node: async () =>
          (await snapshot.evaluateHandle((rows, i) => rows[i]!.node, position)).asElement()!,
      };
    });
  }
  async observe(): Promise<Observation> {
    await this.ready;
    const id = `o${++this.generation}`;
    this.refs.clear();
    const elements: UiElement[] = [];
    const texts: string[] = [];
    for (const frame of this.page.frames()) {
      try {
        if (frame.url() !== 'about:blank' && !allowedUrl(frame.url(), this.profile)) continue;
        const records = await this.scanFrame(frame, id);
        for (const record of records) {
          this.refs.set(record.ref, record);
          const { domIndex, node, ...el } = record;
          elements.push(el);
        }
        const frameTexts = await frame
          .evaluate(() => document.body?.innerText ?? '')
          .catch(() => '');
        texts.push(
          ...frameTexts
            .split(/\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        );
      } catch (error) {
        if (this.page.isClosed()) throw new SurfaceError('SESSION_LOST');
      }
    }
    this.observation = { id, url: this.page.url(), elements, texts };
    return this.observation;
  }
  currentRef(ref: string): UiElement {
    const record = this.refs.get(ref);
    if (!record) throw new SurfaceError('STALE_OBSERVATION_REF');
    const { domIndex, node, ...element } = record;
    return element;
  }
  async resolve(target: Target, inputs: Inputs): Promise<ElementHandle<HTMLElement>> {
    return (await this.resolveRecord(target, inputs)).node();
  }
  private async resolveRecord(target: Target, inputs: Inputs): Promise<Scanned> {
    const frame = this.locateFrame(target.frame);
    const records = await this.scanFrame(frame, `r${this.generation}`);
    const matches = target.anchors.map((anchor) => {
      switch (anchor.by) {
        case 'label':
          return records.filter((r) => r.label === alias(anchor.text, this.profile));
        case 'role':
          return records.filter(
            (r) => r.role === anchor.role && r.name === alias(anchor.name, this.profile),
          );
        case 'text':
          return records.filter((r) => r.text === alias(anchor.text, this.profile));
        case 'near':
          return records.filter((r) => r.near === alias(anchor.text, this.profile));
        case 'tableRow':
          return records.filter(
            (r) =>
              r.row?.header === alias(anchor.header, this.profile) &&
              r.row.key === valueOf(anchor.key, inputs) &&
              r.row.name === alias(anchor.name, this.profile),
          );
      }
    });
    if (matches.some((m) => m.length > 1)) throw new SurfaceError('AMBIGUOUS_TARGET');
    if (target.required.some((index) => matches[index]?.length !== 1))
      throw new SurfaceError('MANDATORY_ANCHOR_MISSING');
    const present = matches.filter((m) => m.length === 1).map((m) => m[0]!);
    if (!present.length) throw new SurfaceError('TARGET_NOT_FOUND');
    if (new Set(present.map((r) => r.domIndex)).size > 1)
      throw new SurfaceError('ANCHOR_DISAGREEMENT');
    if (present.length < target.minAgree) throw new SurfaceError('ANCHOR_QUORUM_FAILED');
    if (present.length < target.anchors.length) {
      const warning = `MISSING_ANCHORS_${target.anchors.length - present.length}`;
      if (!this.drift.includes(warning)) this.drift.push(warning);
    }
    return present[0]!;
  }
  async read(target: Target, inputs: Inputs): Promise<string> {
    const locator = await this.resolve(target, inputs);
    try {
      if (!(await locator.evaluate((el) => el.isConnected)))
        throw new SurfaceError('TARGET_CHANGED');
      return (await locator.innerText()).trim();
    } finally {
      await locator.dispose();
    }
  }
  async act(
    action: Action,
    targets: Record<string, Target>,
    inputs: Inputs,
    expectedEpoch = this.session.epoch,
  ): Promise<string | void> {
    await this.ready;
    await this.recorderReady;
    const epoch = expectedEpoch;
    return this.session
      .dispatch(epoch, async () => {
        if (this.page.isClosed()) throw new SurfaceError('SESSION_LOST');
        if (action.type === 'navigate') {
          let path = action.route.template;
          path = path.replace(/:([A-Za-z_][\w]*)/g, (_match, key: string) => {
            const binding = action.route.bindings[key];
            if (!Object.hasOwn(action.route.bindings, key) || !binding)
              throw new SurfaceError('UNBOUND_ROUTE');
            return encodeURIComponent(valueOf(binding, inputs));
          });
          if (/:[A-Za-z]/.test(path)) throw new SurfaceError('UNBOUND_ROUTE');
          const url = new URL(path, this.profile.origin).href;
          if (!allowedUrl(url, this.profile)) throw new PolicyError('DESTINATION_BLOCKED');
          authorizeAction(action, this.profile, this.page.url());
          this.recordAction(action, epoch);
          const blockedBefore = this.network?.blocked ?? 0;
          try {
            await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          } finally {
            await this.recordNetworkViolation(blockedBefore, action, epoch);
          }
          this.refs.clear();
          return;
        }
        const target = targets[action.target];
        if (!target) throw new SurfaceError('UNKNOWN_TARGET');
        const record = await this.resolveRecord(target, inputs);
        const locator = await record.node();
        try {
          const meta = await locator.evaluate((el) => {
            const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
            const tag = el.tagName.toLowerCase();
            const input = el as HTMLInputElement;
            const form = el.closest('form');
            const cell = el.closest('td,th');
            const labels =
              'labels' in input && input.labels
                ? Array.from(input.labels)
                    .map((l) => norm(l.textContent))
                    .filter(Boolean)
                : [];
            const fieldLabel =
              norm(el.getAttribute('aria-label')) ||
              norm(
                el
                  .getAttribute('aria-labelledby')
                  ?.split(/\s+/)
                  .map((id) => document.getElementById(id)?.textContent ?? '')
                  .join(' ') ?? '',
              ) ||
              labels[0] ||
              norm(cell?.previousElementSibling?.textContent ?? '');
            return {
              connected: el.isConnected,
              fieldLabel,
              tag,
              liveName:
                norm(el.getAttribute('aria-label')) ||
                (tag === 'input' ? input.value : norm(el.textContent)),
              type: input.type,
              href: el instanceof HTMLAnchorElement ? el.href : undefined,
              formAction: form?.action,
              formMethod: form?.method,
            };
          });
          if (
            !meta.connected ||
            meta.tag !== record.tag ||
            (record.type !== undefined && meta.type !== record.type) ||
            meta.href !== record.href ||
            ((action.type === 'fill' || action.type === 'select') &&
              meta.fieldLabel !== record.label)
          )
            throw new SurfaceError('TARGET_CHANGED');
          // Clicks are authorized on the live accessible name. Fields use the label the
          // observer derived (ARIA, <label>, or neighbouring cell): legacy inputs often
          // have no name of their own.
          const name =
            action.type === 'fill' || action.type === 'select'
              ? (record.label ?? record.name)
              : meta.liveName;
          const frameUrl = this.locateFrame(target.frame).url();
          authorizeAction(action, this.profile, frameUrl, {
            role: record.role,
            name,
            type: meta.type,
            href: meta.href,
            formAction: meta.formAction,
            formMethod: meta.formMethod,
          });
          await writeEvent(this.options.journalPath, {
            runId: this.session.runId,
            type: 'action',
            actor: 'automation',
            action: action.type,
            target: action.target,
            epoch,
          });
          // Resolution and journal I/O may outlive a pause request. Fence again at
          // actual browser dispatch, not just when entering the serialized queue.
          this.recordAction(action, epoch);
          const blockedBefore = this.network?.blocked ?? 0;
          try {
            if (action.type === 'read') return (await locator.innerText()).trim();
            if (action.type === 'fill')
              await locator.fill(valueOf(action.value, inputs), { timeout: 10_000 });
            if (action.type === 'select')
              await locator.selectOption(valueOf(action.value, inputs), { timeout: 10_000 });
            if (action.type === 'click') {
              if (meta.href || meta.formAction) {
                // These server-rendered vendor actions navigate the acting frame,
                // including retries of the same URL. Subscribe before dispatch.
                await Promise.all([
                  this.locateFrame(target.frame).waitForNavigation({
                    waitUntil: 'domcontentloaded',
                    timeout: 10000,
                  }),
                  locator.click({ timeout: 10000 }),
                ]);
              } else await locator.click({ timeout: 10000 });
            }
          } finally {
            await this.recordNetworkViolation(blockedBefore, action, epoch);
          }
          this.refs.clear();
        } finally {
          await locator.dispose().catch(() => {});
        }
      })
      .catch((error) => {
        // A rejected stale proposal is successful fencing, not an unsafe dispatch.
        if (error?.code === 'STALE_CONTROL_EPOCH' || error?.code === 'CONTROL_NOT_AUTOMATION')
          void writeEvent(this.options.journalPath, {
            runId: this.session.runId,
            type: 'control_rejection',
            code: 'STALE_CONTROL_EPOCH',
          });
        throw error;
      });
  }
  private recordAction(action: Action, epoch: number): void {
    this.session.assertOwner(epoch);
    this.metrics.actionCount++;
    this.metrics.actionSequence.push(
      action.type === 'navigate' ? 'navigate' : `${action.type}:${action.target}`,
    );
  }
  private async recordNetworkViolation(
    before: number,
    action: Action,
    epoch: number,
  ): Promise<void> {
    if ((this.network?.blocked ?? 0) <= before) return;
    this.metrics.unsafeDispatch++;
    await writeEvent(this.options.journalPath, {
      runId: this.session.runId,
      type: 'unsafe_dispatch',
      action: action.type,
      target: 'target' in action ? action.target : undefined,
      epoch,
    });
  }
  async check(
    predicate: Predicate,
    targets: Record<string, Target>,
    inputs: Inputs,
    outputs: Inputs = {},
  ): Promise<boolean> {
    if (predicate.op === 'all') {
      for (const p of predicate.args)
        if (!(await this.check(p, targets, inputs, outputs))) return false;
      return true;
    }
    if (predicate.op === 'any') {
      for (const p of predicate.args)
        if (await this.check(p, targets, inputs, outputs)) return true;
      return false;
    }
    if (predicate.op === 'outputEquals')
      return (
        outputs[predicate.output] !== undefined &&
        outputs[predicate.output] === inputs[predicate.input]
      );
    if (predicate.op === 'routeMatches') {
      const escaped = predicate.template
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:[A-Za-z_][\w]*/g, '[^/]+');
      return this.page.frames().some((frame) => {
        try {
          return new RegExp(`^${escaped}$`).test(new URL(frame.url()).pathname);
        } catch {
          return false;
        }
      });
    }
    if (!('target' in predicate)) throw new SurfaceError('INVALID_PREDICATE');
    const target = targets[predicate.target];
    if (!target) throw new SurfaceError('UNKNOWN_TARGET');
    let locator: ElementHandle<HTMLElement> | undefined;
    try {
      locator = await this.resolve(target, inputs);
      if (!(await locator.evaluate((el) => el.isConnected)))
        throw new SurfaceError('TARGET_CHANGED');
      if (predicate.op === 'visible') return await locator.isVisible();
      if (predicate.op === 'absent') return !(await locator.isVisible());
      if (predicate.op === 'valueEquals')
        return (await locator.inputValue()) === valueOf(predicate.value, inputs);
      if (!('value' in predicate)) throw new SurfaceError('INVALID_PREDICATE');
      return (await locator.innerText()).trim() === valueOf(predicate.value, inputs);
    } catch (error) {
      if (
        error instanceof SurfaceError &&
        [
          'TARGET_NOT_FOUND',
          'FRAME_NOT_FOUND',
          'MANDATORY_ANCHOR_MISSING',
          'ANCHOR_QUORUM_FAILED',
        ].includes(error.code)
      )
        return predicate.op === 'absent';
      throw error;
    } finally {
      await locator?.dispose().catch(() => {});
    }
  }
  async screenshot(path?: string): Promise<Buffer> {
    // Cover every text-bearing leaf and editable control. Evidence retains layout, not data.
    const masks: Locator[] = [];
    for (const frame of this.page.frames())
      masks.push(
        frame.locator('input,textarea,select,td,th,span,strong,b,p,label,h1,h2,h3,h4,a,button'),
      );
    if (path) await mkdir(dirname(path), { recursive: true });
    return this.page.screenshot({ path, mask: masks, maskColor: '#64748b', timeout: 5000 });
  }
  private async installRecorder(): Promise<void> {
    const name = `__operatorEvents_${randomUUID().replaceAll('-', '')}`;
    await this.page.context().exposeBinding(name, async (source, payload: unknown) => {
      if (
        this.session.owner !== 'human' ||
        source.page !== this.page ||
        !allowedUrl(source.frame.url(), this.profile)
      )
        return;
      if (!payload || typeof payload !== 'object') return;
      const { kind, label } = payload as { kind?: unknown; label?: unknown };
      if (!['click', 'change', 'submit'].includes(String(kind))) return;
      // Only vendor label keys are journaled; free page text and values never are.
      const key = typeof label === 'string' ? aliasName(label, this.profile) : '';
      await writeEvent(this.options.journalPath, {
        runId: this.session.runId,
        type: 'human_action',
        actor: this.session.humanActor,
        action: String(kind),
        target: key.startsWith('@') ? key : 'unmapped',
        epoch: this.session.epoch,
      });
    });
    const script = ({ binding }: { binding: string }) => {
      const norm = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
      // Caption of the acted-on control only (never its value or arbitrary text).
      const caption = (node: EventTarget | null): string => {
        const el =
          node instanceof Element ? node.closest('input,select,textarea,button,a,form') : null;
        if (!el) return '';
        if (el instanceof HTMLFormElement) return '';
        const aria = norm(el.getAttribute('aria-label'));
        if (aria) return aria;
        const labels = 'labels' in el ? (el as HTMLInputElement).labels : null;
        if (labels?.[0]) return norm(labels[0].childNodes[0]?.textContent);
        const cell = el.closest('td,th');
        const previous = cell?.previousElementSibling;
        if (el.matches('input,select,textarea')) return previous ? norm(previous.textContent) : '';
        return el instanceof HTMLInputElement ? norm(el.value) : norm(el.textContent);
      };
      for (const kind of ['click', 'change', 'submit'])
        document.addEventListener(
          kind,
          (event) => {
            const emit = (window as unknown as Record<string, (value: unknown) => Promise<void>>)[
              binding
            ];
            if (emit) void emit({ kind, label: caption(event.target) }).catch(() => {});
          },
          true,
        );
    };
    await this.page.context().addInitScript(script, { binding: name });
    for (const frame of this.page.frames())
      await frame.evaluate(script, { binding: name }).catch(() => {});
    this.page.on('framenavigated', (frame) => {
      if (this.session.owner === 'human' && allowedUrl(frame.url(), this.profile))
        void writeEvent(this.options.journalPath, {
          runId: this.session.runId,
          type: 'human_action',
          actor: this.session.humanActor,
          action: 'navigate',
          epoch: this.session.epoch,
        });
    });
  }
}

export interface LaunchOptions {
  profile: Profile;
  headless?: boolean;
  startURL?: string;
  runId?: string;
  rowKeyLabels?: string[];
  journalPath?: string;
  cookies?: Parameters<BrowserContext['addCookies']>[0];
  storageState?: Parameters<Browser['newContext']>[0] extends infer T
    ? T extends { storageState?: infer S }
      ? S
      : never
    : never;
}
export async function launchSurface(options: LaunchOptions) {
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({
    serviceWorkers: 'block',
    acceptDownloads: false,
    viewport: { width: 1280, height: 900 },
    storageState: options.storageState,
  });
  if (options.cookies) await context.addCookies(options.cookies);
  const page = await context.newPage();
  const session = new SessionController(options.runId, options.journalPath);
  const surface = new WebSurface(page, options.profile, {
    session,
    journalPath: options.journalPath,
    rowKeyLabels: options.rowKeyLabels,
  });
  await surface.ready;
  const start = options.startURL;
  if (start) {
    if (!allowedUrl(start, options.profile)) {
      await browser.close();
      throw new PolicyError('DESTINATION_BLOCKED');
    }
    await page.goto(start, { waitUntil: 'load', timeout: 15000 });
  }
  return { browser, context, page, surface, session, close: () => browser.close() };
}
