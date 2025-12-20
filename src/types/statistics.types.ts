// Token usage details
export interface PromptTokensDetails {
  cached_tokens?: number;
  audio_tokens?: number;
  video_tokens?: number;
}

export interface CompletionTokensDetails {
  reasoning_tokens?: number;
  image_tokens?: number;
}

// Cost breakdown
export interface CostDetails {
  upstream_inference_cost?: number;
  upstream_inference_prompt_cost?: number;
  upstream_inference_completions_cost?: number;
}

// Core usage statistics
export interface MessageUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
  is_hvwk?: boolean; // Provider-specific field (some providers)
  is_byok?: boolean; // Provider-specific field (OpenWebUI)
  prompt_tokens_details?: PromptTokensDetails;
  completion_tokens_details?: CompletionTokensDetails;
  cost_details?: CostDetails;
}
