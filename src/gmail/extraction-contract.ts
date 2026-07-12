export const EMAIL_EXTRACTION_PROMPT_VERSION = "email-extraction-v2-message-type";
export const EMAIL_EXTRACTION_SCHEMA_VERSION = "email-extraction-schema-v1";

export const currentEmailExtractionIdentity = {
  promptVersion: EMAIL_EXTRACTION_PROMPT_VERSION,
  schemaVersion: EMAIL_EXTRACTION_SCHEMA_VERSION,
} as const;
