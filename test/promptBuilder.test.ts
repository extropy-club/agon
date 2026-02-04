import assert from "node:assert/strict";
import test from "node:test";

import type * as Prompt from "@effect/ai/Prompt";

import { buildPrompt } from "../src/lib/promptBuilder.js";

const asMessages = (raw: Prompt.RawInput): ReadonlyArray<Prompt.MessageEncoded> => {
  assert.ok(Array.isArray(raw));
  return raw as ReadonlyArray<Prompt.MessageEncoded>;
};

const userMessageParts = (m: Prompt.MessageEncoded): ReadonlyArray<Prompt.TextPartEncoded> => {
  assert.equal(m.role, "user");
  const user = m as Prompt.UserMessageEncoded;
  assert.ok(Array.isArray(user.content));
  return user.content as ReadonlyArray<Prompt.TextPartEncoded>;
};

test("buildPrompt: system message is pure agent.systemPrompt", () => {
  const prompt = buildPrompt(
    { title: "Debate Room", topic: "Some topic" },
    { systemPrompt: "SYSTEM_ONLY" },
    [],
  );

  const messages = asMessages(prompt);
  assert.deepEqual(messages[0], { role: "system", content: "SYSTEM_ONLY" });
});

test("buildPrompt: moderator message includes title/topic/rules and is wrapped in XML", () => {
  const prompt = buildPrompt(
    { title: "My <Room>", topic: "Cats & Dogs" },
    { systemPrompt: "SYS" },
    [],
  );

  const messages = asMessages(prompt);
  const moderator = messages[1];
  assert.ok(moderator);
  const parts = userMessageParts(moderator);

  assert.equal(parts.length, 1);
  const xml = parts[0]!.text;

  assert.ok(xml.startsWith('<message author="Moderator" audience="false">'));
  assert.ok(xml.includes("Room title: My &lt;Room&gt;"));
  assert.ok(xml.includes("Topic: Cats &amp; Dogs"));
  assert.ok(xml.includes("Rules:"));
  assert.ok(xml.endsWith("</message>"));
});

test("buildPrompt: history messages use role=user, have XML attribution, and escape content", () => {
  const prompt = buildPrompt({ title: "Room", topic: "Topic" }, { systemPrompt: "SYS" }, [
    { authorName: "Aristotle", authorType: "agent", content: "Hello & <world>" },
  ]);

  const messages = asMessages(prompt);
  const msg = messages[2];
  assert.ok(msg);
  const parts = userMessageParts(msg);

  assert.equal(parts.length, 1);
  assert.equal(
    parts[0]!.text,
    '<message author="Aristotle" audience="false">Hello &amp; &lt;world&gt;</message>',
  );
});

test("buildPrompt: authorName is escaped in the XML author attribute", () => {
  const prompt = buildPrompt({ title: "Room", topic: "Topic" }, { systemPrompt: "SYS" }, [
    { authorName: 'O\'Reilly "A&B" <X>', authorType: "agent", content: "Hi" },
  ]);

  const messages = asMessages(prompt);
  const msg = messages[2];
  assert.ok(msg);
  const parts = userMessageParts(msg);

  assert.equal(parts.length, 1);
  assert.equal(
    parts[0]!.text,
    '<message author="O&apos;Reilly &quot;A&amp;B&quot; &lt;X&gt;" audience="false">Hi</message>',
  );
});

test("buildPrompt: consecutive audience messages are batched into one user message with multiple parts", () => {
  const prompt = buildPrompt({ title: "Room", topic: "Topic" }, { systemPrompt: "SYS" }, [
    { authorName: "John", authorType: "audience", content: "First" },
    { authorName: "Jane", authorType: "audience", content: "Second" },
    { authorName: "Aristotle", authorType: "agent", content: "Response" },
    { authorName: "Bob", authorType: "audience", content: "Third" },
    { authorName: "Ann", authorType: "audience", content: "Fourth" },
  ]);

  const messages = asMessages(prompt);

  // system + moderator + audience batch + agent message + audience batch
  assert.equal(messages.length, 5);

  const batch1Msg = messages[2];
  assert.ok(batch1Msg);
  const batch1 = userMessageParts(batch1Msg);
  assert.equal(batch1.length, 2);
  assert.equal(batch1[0]!.text, '<message author="John" audience="true">First</message>');
  assert.equal(batch1[1]!.text, '<message author="Jane" audience="true">Second</message>');

  const agentMsgMessage = messages[3];
  assert.ok(agentMsgMessage);
  const agentMsg = userMessageParts(agentMsgMessage);
  assert.equal(agentMsg.length, 1);
  assert.equal(
    agentMsg[0]!.text,
    '<message author="Aristotle" audience="false">Response</message>',
  );

  const batch2Msg = messages[4];
  assert.ok(batch2Msg);
  const batch2 = userMessageParts(batch2Msg);
  assert.equal(batch2.length, 2);
  assert.equal(batch2[0]!.text, '<message author="Bob" audience="true">Third</message>');
  assert.equal(batch2[1]!.text, '<message author="Ann" audience="true">Fourth</message>');
});
