import type * as Prompt from "@effect/ai/Prompt";

export type PromptBuilderRoom = {
  readonly title: string;
  readonly topic: string;
};

export type PromptBuilderAgent = {
  readonly id: string;
  readonly name: string;
  readonly systemPrompt: string;
};

export type PromptBuilderMessage = {
  readonly authorName: string;
  readonly authorType: string;
  readonly content: string;
};

const escapeXmlText = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeXmlAttribute = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const wrapXmlMessage = (args: {
  readonly authorName: string;
  readonly isAudience: boolean;
  readonly content: string;
}): string => {
  const contentEscaped = escapeXmlText(args.content);
  const authorNameEscaped = escapeXmlAttribute(args.authorName);
  const audience = args.isAudience ? "true" : "false";
  return `<message author="${authorNameEscaped}" audience="${audience}">${contentEscaped}</message>`;
};

const houseRules = `<rules>
- Stay on topic.
- Aim for 5-10 sentences per reply.
- Address other participants by name when responding to their points.
- Do not discuss being an AI, a language model, or your own limitations.
- Use plain text for math (e.g. x^2, sqrt(x), a/b). Never use LaTeX notation.
</rules>`;

const discordFormat = `<format>
You are posting in a Discord thread.
- Use Markdown: **bold**, *italic*, \`code\`, \`\`\`code blocks\`\`\`.
- Use line breaks for readability. Avoid walls of text.
- No HTML. No LaTeX. No embeds.
</format>`;

const buildIdentity = (agent: PromptBuilderAgent): string => `<identity>
Your name is ${agent.name}. Your id is ${agent.id}.
Messages are tagged with an author attribute — use it to know who is speaking.
When someone addresses you by name, respond directly to them.
When the audience (audience="true") asks you a question or challenges your point, engage with it.
You are one of several participants in a structured debate.
</identity>`;

const buildSystemPrompt = (agent: PromptBuilderAgent): string =>
  `${buildIdentity(agent)}\n\n${agent.systemPrompt}\n\n${houseRules}\n\n${discordFormat}`;

const buildModeratorContent = (room: PromptBuilderRoom): string =>
  `Room title: ${room.title}\nTopic: ${room.topic}`;

const textPart = (text: string): Prompt.TextPartEncoded => ({ type: "text", text });

export const buildPrompt = (
  room: PromptBuilderRoom,
  agent: PromptBuilderAgent,
  messages: ReadonlyArray<PromptBuilderMessage>,
): Prompt.RawInput => {
  const prompt: Array<Prompt.MessageEncoded> = [
    { role: "system", content: buildSystemPrompt(agent) },
  ];

  const hasModeratorMessage = messages.some((m) => m.authorType === "moderator");

  // Back-compat: older rooms might not have a persisted moderator message.
  if (!hasModeratorMessage) {
    prompt.push({
      role: "user",
      content: [
        textPart(
          wrapXmlMessage({
            authorName: "Moderator",
            isAudience: false,
            content: buildModeratorContent(room),
          }),
        ),
      ],
    });
  }

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const isAudience = m.authorType === "audience";

    if (!isAudience) {
      prompt.push({
        role: "user",
        content: [
          textPart(
            wrapXmlMessage({
              authorName: m.authorName,
              isAudience: false,
              content: m.content,
            }),
          ),
        ],
      });
      i += 1;
      continue;
    }

    // batch consecutive audience messages into one user message with multiple parts
    const parts: Array<Prompt.TextPartEncoded> = [];

    while (i < messages.length && messages[i].authorType === "audience") {
      const a = messages[i];
      parts.push(
        textPart(
          wrapXmlMessage({
            authorName: a.authorName,
            isAudience: true,
            content: a.content,
          }),
        ),
      );
      i += 1;
    }

    prompt.push({ role: "user", content: parts });
  }

  return prompt;
};
