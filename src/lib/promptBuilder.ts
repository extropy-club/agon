import type * as Prompt from "@effect/ai/Prompt";

export type PromptBuilderRoom = {
  readonly title: string;
  readonly topic: string;
};

export type PromptBuilderAgent = {
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

const moderatorRules = `Rules:\n- Stay on topic.\n- No meta talk about being an AI.\n- Aim for 5-10 sentences.\n- If you want to end, say 'Goodbye.'`;

const buildModeratorContent = (room: PromptBuilderRoom): string =>
  `Room title: ${room.title}\nTopic: ${room.topic}\n\n${moderatorRules}`;

const textPart = (text: string): Prompt.TextPartEncoded => ({ type: "text", text });

export const buildPrompt = (
  room: PromptBuilderRoom,
  agent: PromptBuilderAgent,
  messages: ReadonlyArray<PromptBuilderMessage>,
): Prompt.RawInput => {
  const prompt: Array<Prompt.MessageEncoded> = [
    { role: "system", content: agent.systemPrompt },
    {
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
    },
  ];

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
