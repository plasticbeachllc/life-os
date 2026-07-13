import { gmailPromptSpec } from "../orchestration/prompt-contracts";

export const EMAIL_EXTRACTION_PROMPT_VERSION = gmailPromptSpec.version;
export const EMAIL_EXTRACTION_SCHEMA_VERSION = "email-extraction-schema-v3-relations";

export const currentEmailExtractionIdentity = {
  promptVersion: EMAIL_EXTRACTION_PROMPT_VERSION,
  schemaVersion: EMAIL_EXTRACTION_SCHEMA_VERSION,
} as const;
