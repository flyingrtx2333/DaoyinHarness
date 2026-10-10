// The gateway owns a 140s provider deadline; allow it to persist and return failure
// before the Agent's 150s deadline and the adapter's 160s transport deadline.
export const CLOUD_MODEL_TIMEOUT_MS = 150_000;
export const CLOUD_MODEL_TRANSPORT_TIMEOUT_MS = 160_000;
// Routing is a bounded LLM operation, not a sub-second local lookup.
export const CLOUD_CAPABILITY_TIMEOUT_MS = 10_000;
export const CLOUD_CAPABILITY_TRANSPORT_TIMEOUT_MS = 12_000;
