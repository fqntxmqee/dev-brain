/**
 * 全局常量收口。
 * 把分散在 feishu-cards / task-planner / brain-engine 等处的 80/100/120/200/300/500 等
 * 数字字面量集中到此处，便于审计与 ESLint `no-magic-numbers` 规则触发。
 */
export const MAX_DESC_LEN = 300;
export const MAX_OUTPUT_LEN = 200;
export const MAX_CARD_FIELD_LEN = 80;
export const MAX_SUBTASK_TITLE_LEN = 100;
export const MAX_REPLY_TEXT_BYTES = 16 * 1024;
export const MAX_PROMPT_BYTES = 4 * 1024;
export const MESSAGE_DEDUP_WINDOW_MS = 5 * 60 * 1000;
export const MESSAGE_DEDUP_MAX = 10_000;
export const PENDING_QUEUE_MAX = 3;
export const SHORT_ID_LEN = 12;
export const RETRY_MAX = 3;
