const test = require('node:test');
const assert = require('node:assert/strict');
const { createPracticeClient, STEPS, lastUserText } = require('../src/main/practiceClient');

// Drive the practice client the way GuideSession does: each call gets the running message list.
function harness(visible = new Set(['sent', 'row-alysa', 'addr', 'compose', 'to', 'body', 'send'])) {
  const located = [];
  const client = createPracticeClient({
    delayMs: 0,
    locate: async (id) => {
      located.push(id);
      return visible.has(id) ? { x: 100, y: 200 } : null;
    },
  });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'goal' }] }];
  async function next(observation) {
    if (observation) {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: observation }] }],
      });
    }
    const res = await client.beta.messages.create({ messages });
    messages.push({ role: 'assistant', content: res.content });
    return res.content[0];
  }
  return { next, visible, located };
}

test('walks through the whole practice email, using the person\'s own words', async () => {
  const { next } = harness();
  let call = await next();
  assert.equal(call.name, 'ask_user');
  call = await next('The person answered: "No, I don\'t"');
  assert.equal(call.input.target, 'the Sent folder');
  assert.match(call.input.say, /we can find it/);
  call = await next('The person clicked where you pointed.');
  assert.equal(call.input.target, 'the email to Alysa');
  call = await next('The person clicked where you pointed.');
  assert.equal(call.input.action, 'look');
  call = await next('The person pressed "I did it".');
  assert.equal(call.input.target, 'the Compose button');
  call = await next('The person clicked where you pointed.');
  assert.equal(call.input.type_text, 'alysa2002@gmail.com');
  call = await next('The person typed something and then pressed Enter.');
  assert.equal(call.name, 'ask_user');
  call = await next('The person answered: "See you on Sunday!"');
  assert.equal(call.input.type_text, 'See you on Sunday!');
  call = await next('The person typed something and then said they were done.');
  assert.equal(call.input.target, 'the Send button');
  call = await next('The person clicked where you pointed.');
  assert.equal(call.name, 'finish');
  assert.equal(call.input.success, true);
  assert.deepEqual(call.input.remember, []);
});

test('a missed click re-points kindly at the same thing; stuck gives a hint', async () => {
  const { next } = harness();
  await next();
  await next('The person answered: "Yes"');
  let call = await next('The person clicked somewhere else at (5, 5) — not on "the Sent folder".');
  assert.equal(call.input.target, 'the Sent folder');
  assert.match(call.input.say, /^That's okay\. Let's try this one\./);
  call = await next('The person pressed "I\'m stuck" — they can\'t find it.');
  assert.equal(call.input.target, 'the Sent folder');
  assert.match(call.input.say, /on the left side/);
});

test('if the new message was closed, Naomi goes back to open it again', async () => {
  const h = harness();
  const { next, visible } = h;
  await next();
  await next('The person answered: "Yes"'); // sent
  await next('The person clicked where you pointed.'); // row
  await next('The person clicked where you pointed.'); // addr
  await next('The person pressed "I did it".'); // compose
  visible.delete('to'); // they closed the new message
  const call = await next('The person clicked where you pointed.');
  assert.equal(call.input.target, 'the Compose button');
  assert.match(call.input.say, /Oops, that closed/);
  visible.add('to');
  const again = await next('The person clicked where you pointed.');
  assert.equal(again.input.target, 'the To box');
});

test('no practice window at all asks the person, then retries the same step', async () => {
  const { next, visible } = harness(new Set());
  await next();
  let call = await next('The person answered: "Yes"');
  assert.equal(call.name, 'ask_user');
  assert.match(call.input.question, /Practice Mail window/);
  visible.add('sent');
  call = await next('The person answered: "Yes, it\'s open"');
  assert.equal(call.input.target, 'the Sent folder');
});

test('lastUserText reads tool results and plain text', () => {
  assert.equal(lastUserText([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), 'hi');
  assert.equal(
    lastUserText([{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok' }, { type: 'image' }] }] }]),
    'ok',
  );
  assert.ok(STEPS.at(-1).tool === 'finish');
});
