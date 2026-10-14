import {
  DEMO_CONTRACT,
  DEMO_FIELDS,
  type Capability,
  type Target,
  type Predicate,
  type Step,
} from '../src/schema/index.js';
import { sealCapability } from '../src/compiler/compile.js';

/** Handwritten test fixture. This is NEVER evidence of a live discovery run. */
export function createFixtureCapability(): Capability {
  const frame = ['main', 'content'];
  const heading = (text: string): Target => ({
    frame,
    anchors: [
      { by: 'role', role: 'heading', name: text },
      { by: 'text', text },
    ],
    minAgree: 2,
    required: [0],
  });
  const field = (text: string, role = 'textbox'): Target => ({
    frame,
    anchors: [
      { by: 'label', text },
      { by: 'role', role, name: text },
    ],
    minAgree: 2,
    required: [0],
  });
  const button = (name: string, role = 'button'): Target => ({
    frame,
    anchors: [
      { by: 'role', role, name },
      { by: 'text', text: name },
    ],
    minAgree: 2,
    required: [0],
  });
  const output = (text: string): Target => ({
    frame,
    anchors: [{ by: 'near', text }],
    minAgree: 1,
    required: [0],
  });
  const targets: Record<string, Target> = {
    search: heading('@searchHeading'),
    results: heading('@resultsHeading'),
    detail: heading('@detailHeading'),
    form: heading('@formHeading'),
    review: heading('@reviewHeading'),
    member: field('@memberId'),
    searchButton: button('@searchButton'),
    row: {
      frame,
      anchors: [
        { by: 'tableRow', header: '@memberId', key: { input: 'memberId' }, name: '@viewButton' },
      ],
      minAgree: 1,
      required: [0],
    },
    newButton: button('@newAccountButton', 'link'),
    product: field('@productCode', 'combobox'),
    nickname: field('@nickname'),
    deposit: field('@deposit'),
    reviewButton: button('@reviewButton'),
    outMember: output('@memberId'),
    outProduct: output('@productCode'),
    outNickname: output('@nickname'),
    outDeposit: output('@deposit'),
  };
  const visible = (target: string): Predicate => ({ op: 'visible', target });
  const value = (target: string, input: string, format?: 'minor_to_decimal'): Predicate => ({
    op: 'valueEquals',
    target,
    value: { input, ...(format ? { format } : {}) },
  });
  const steps: Step[] = [
    {
      id: 's1',
      action: { type: 'navigate', route: { template: '/core', bindings: {} } },
      post: visible('search'),
      effect: 'read',
      repeat: 'read',
      timeoutMs: 10000,
    },
    {
      id: 's2',
      action: { type: 'fill', target: 'member', value: { input: 'memberId' } },
      pre: visible('search'),
      post: value('member', 'memberId'),
      effect: 'draft',
      repeat: 'same_value',
      timeoutMs: 10000,
    },
    {
      id: 's3',
      action: { type: 'click', target: 'searchButton' },
      pre: value('member', 'memberId'),
      post: visible('results'),
      effect: 'read',
      repeat: 'read',
      timeoutMs: 10000,
    },
    {
      id: 's4',
      action: { type: 'click', target: 'row' },
      pre: visible('results'),
      post: visible('detail'),
      effect: 'read',
      repeat: 'read',
      timeoutMs: 10000,
    },
    {
      id: 's5',
      action: { type: 'click', target: 'newButton' },
      pre: visible('detail'),
      post: visible('form'),
      effect: 'read',
      repeat: 'read',
      timeoutMs: 10000,
    },
    {
      id: 's6',
      action: { type: 'select', target: 'product', value: { input: 'productCode' } },
      pre: visible('form'),
      post: value('product', 'productCode'),
      effect: 'draft',
      repeat: 'same_value',
      timeoutMs: 10000,
    },
    {
      id: 's7',
      action: { type: 'fill', target: 'nickname', value: { input: 'nickname' } },
      pre: visible('form'),
      post: value('nickname', 'nickname'),
      effect: 'draft',
      repeat: 'same_value',
      timeoutMs: 10000,
    },
    {
      id: 's8',
      action: {
        type: 'fill',
        target: 'deposit',
        value: { input: 'openingDepositMinor', format: 'minor_to_decimal' },
      },
      pre: visible('form'),
      post: value('deposit', 'openingDepositMinor', 'minor_to_decimal'),
      effect: 'draft',
      repeat: 'same_value',
      timeoutMs: 10000,
    },
    {
      id: 's9',
      action: { type: 'click', target: 'reviewButton' },
      pre: value('deposit', 'openingDepositMinor', 'minor_to_decimal'),
      post: visible('review'),
      effect: 'draft',
      repeat: 'never',
      timeoutMs: 10000,
    },
  ];
  return sealCapability({
    schemaVersion: 1,
    id: 'fixture_savings_review',
    version: 1,
    description: 'Handwritten test fixture; not live discovery evidence.',
    app: { vendor: 'legacy-core', versions: ['7.1'] },
    inputs: DEMO_FIELDS,
    outputs: {
      memberId: { type: 'string', from: 'outMember', parser: 'text' },
      productCode: { type: 'string', from: 'outProduct', parser: 'text' },
      nickname: { type: 'string', from: 'outNickname', parser: 'text' },
      openingDepositMinor: { type: 'integer', from: 'outDeposit', parser: 'usd_to_minor' },
    },
    identity: DEMO_CONTRACT.identity,
    targets,
    steps,
    completion: {
      op: 'all',
      args: [
        visible('review'),
        ...Object.keys(DEMO_FIELDS).map((output) => ({
          op: 'outputEquals' as const,
          output,
          input: output,
        })),
      ],
    },
    exceptions: 'legacy-core@7:exceptions',
    provenance: {
      source: 'test_fixture',
      discoveryRun: 'handwritten-fixture',
      model: 'none',
      createdAt: '2026-10-05T00:00:00Z',
    },
  });
}
