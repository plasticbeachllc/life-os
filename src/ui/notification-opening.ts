export interface NotificationAgentSummary {
  sentences: string[];
  actionRequired: boolean;
}

export const notificationOpeningOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assessment", "recommendedNextStep", "question", "actionRequired"],
  properties: {
    assessment: { type: "string", minLength: 1, maxLength: 180 },
    recommendedNextStep: { type: "string", minLength: 1, maxLength: 180 },
    question: { anyOf: [{ type: "string", minLength: 1, maxLength: 180 }, { type: "null" }] },
    actionRequired: { type: "boolean" },
  },
} as const;

const forbiddenSummaryContent = /(?:sha256:|https?:\/\/|(?:^|\s)(?:~\/|\/Users\/|[A-Za-z]:\\)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:message|thread|event|proposal|state|call|manifest|cache|run|action)_[A-Za-z0-9_-]+\b|\b[a-f0-9]{40,}\b|<[^>]+>)/i;

export function buildNotificationOpeningPrompt(input: {
  groundedContext: unknown[];
  actionRequired: boolean;
  repair?: boolean;
}): string {
  return `${notificationOpeningInstructions(input.actionRequired, input.repair)}

Grounded context:
${JSON.stringify(input.groundedContext)}`;
}

export function notificationOpeningInstructions(actionRequired: boolean, repair = false): string {
  return `${repair ? "Repair the prior attempt and produce" : "Produce"} the opening response for a focused discussion about this LifeOS Inbox item.

Use only the grounded context below. Do not call tools or invent missing facts.
- assessment: State the bottom line and why it matters to the user. Add judgment; do not merely repeat the title or summary. Do not speculate about consequences: use a consequence only when the grounded context states it; otherwise explain the practical uncertainty.
- recommendedNextStep: Recommend one concrete, proportionate next move using a specific verb. ${actionRequired
    ? "The user needs to act, so do not say only to review, consider, monitor, or follow up without saying exactly what to check, decide, or communicate."
    : "No action is required; say that plainly and identify the condition that would change that."}
- question: Ask one short, answerable question only if the user may already know the answer and it would materially change the recommended next step. Do not ask a question that is answered by carrying out the recommended next step. If question is not null, recommendedNextStep must explain what to do after the answer or why the answer matters; it must not repeat the question as an imperative. Otherwise return null.
- actionRequired: Return exactly ${actionRequired}.

Write directly to the user in calm, natural language. Distinguish inference with words such as “likely.” Never mention LifeOS, notifications, findings, context, or implementation state. Do not include identifiers, hashes, addresses, URLs, HTML, file paths, or source excerpts. Return only the requested structured output.`;
}

export function normalizeNotificationOpening(text: string,
  expectedActionRequired: boolean): NotificationAgentSummary {
  if (text.length > 1_000) throw new Error("Notification summary output exceeds the transport bound");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Notification summary is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Notification opening must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["assessment", "recommendedNextStep", "question", "actionRequired"].includes(key))) {
    throw new Error("Notification opening contains unexpected fields");
  }
  if (record.actionRequired !== expectedActionRequired) throw new Error("Notification opening action state is inconsistent");
  if (typeof record.assessment !== "string" || typeof record.recommendedNextStep !== "string"
    || (record.question !== null && typeof record.question !== "string")) {
    throw new Error("Notification opening fields are invalid");
  }
  return validateNotificationSummary({
    sentences: [record.assessment, record.recommendedNextStep,
      ...(typeof record.question === "string" ? [record.question] : [])],
    actionRequired: record.actionRequired,
  }, expectedActionRequired);
}

export function validateNotificationSummary(value: unknown,
  expectedActionRequired: boolean): NotificationAgentSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Notification summary must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "sentences" && key !== "actionRequired")) {
    throw new Error("Notification summary contains unexpected fields");
  }
  if (!Array.isArray(record.sentences) || record.sentences.length < 2 || record.sentences.length > 3) {
    throw new Error("Notification summary must contain 2-3 sentences");
  }
  if (record.actionRequired !== expectedActionRequired) throw new Error("Notification summary action state is inconsistent");
  const sentences = record.sentences.map((item) => {
    if (typeof item !== "string") throw new Error("Notification summary sentence must be text");
    const sentence = item.replace(/\s+/g, " ").trim();
    if (!sentence || sentence.length > 180) throw new Error("Notification summary sentence exceeds its bound");
    if (forbiddenSummaryContent.test(sentence)) throw new Error("Notification summary contains private or unsafe output");
    return sentence;
  });
  if (sentences.join(" ").length > 420) throw new Error("Notification summary exceeds its total bound");
  return { sentences, actionRequired: expectedActionRequired };
}
