import assert from 'node:assert/strict';
import { OpenAIOptionResearcher } from './research.js';

let request: Record<string, unknown> | undefined;
let fetchCount = 0;
const researcher = new OpenAIOptionResearcher({
  apiKey: 'openai-secret',
  model: 'research-model',
  fetch: async (_url, init) => {
    fetchCount += 1;
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({
            options: [
              { venue: 'K1 Speed', time: 'Thursday 7 PM', slot: 'Thursday Evening', format: 'Go-karting', price: 35, location: 'South San Francisco', sourceUrl: 'https://example.com/k1', evidence: 'Thursday hours verified' },
              { venue: 'Mini Golf', time: 'Friday 6 PM', slot: 'Friday Evening', format: 'Mini golf', price: 20, location: 'San Francisco', sourceUrl: 'https://example.com/golf', evidence: 'Reservations available' },
            ],
          }),
        }],
      }],
    }), { status: 200 });
  },
});

const options = await researcher.research({
  goal: 'hang out this week',
  query: 'group activities this week',
  locationHint: 'San Francisco',
  participantCount: 3,
});
assert.equal(options.length, 2);
assert.equal(options[0]?.slot, 'thursday_evening');
assert.equal(options[0]?.sourceUrl, 'https://example.com/k1');
assert.equal(request?.model, 'research-model');
assert.deepEqual(request?.tools, [{ type: 'web_search' }]);
assert.deepEqual(request?.reasoning, { effort: 'none' });
assert.equal(JSON.stringify(request).includes('group activities this week'), true);
const cachedOptions = await researcher.research({
  goal: 'hang out this week',
  query: 'group activities this week',
  locationHint: 'San Francisco',
  participantCount: 4,
});
assert.equal(fetchCount, 1);
assert.notEqual(cachedOptions[0]?.id, options[0]?.id);
console.info('option research test passed');
