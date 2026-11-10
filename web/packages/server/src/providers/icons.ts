import type { ProviderIcon } from '@maudecode/talaria-web-contracts'

/**
 * TAL-1858: the App's provider icons (`app/Talaria/Models/ProviderIconRegistry.swift`), whose SVGs Web serves from
 * `static/brand/providers/<asset>.svg`. Keyed only by a catalog `provider_id`; a model id is never read. `icons.test.ts`
 * keeps this table, the colour set and the SVGs equal to the App's.
 */
const ASSETS: Readonly<Record<string, string>> = {
  'actual': 'Actual', 'actual-computer': 'Actual', 'actualcomputer': 'Actual', 'aci': 'Actual',
  'ai-gateway': 'Vercel', 'vercel': 'Vercel', 'vercel-ai-gateway': 'Vercel', 'ai_gateway': 'Vercel', 'aigateway': 'Vercel',
  'alibaba': 'Alibaba', 'alibaba-coding-plan': 'Alibaba', 'dashscope': 'Alibaba', 'alibaba-cloud': 'Alibaba', 'qwen-dashscope': 'Alibaba',
  'anthropic': 'Anthropic', 'claude': 'Anthropic',
  'arcee': 'Arcee', 'arcee-ai': 'Arcee', 'arceeai': 'Arcee',
  'azure-foundry': 'AzureAI', 'azure': 'AzureAI', 'azure-ai-foundry': 'AzureAI', 'azure-ai': 'AzureAI',
  'bedrock': 'AWS', 'aws-bedrock': 'AWS',
  'copilot': 'Copilot', 'github-copilot': 'Copilot', 'copilot-acp': 'Copilot',
  'commandcode': 'CommandCode', 'commandcode-chat': 'CommandCode', 'commandcode-anthropic': 'CommandCode', 'commandcode-claude': 'CommandCode',
  'cursor-acp': 'Cursor',
  'deepinfra': 'DeepInfra', 'deep-infra': 'DeepInfra', 'deepinfra-ai': 'DeepInfra',
  'deepseek': 'DeepSeek',
  'fireworks': 'Fireworks', 'fireworks-ai': 'Fireworks', 'fw': 'Fireworks',
  'gmi': 'GMI', 'gmi-cloud': 'GMI', 'gmicloud': 'GMI',
  'google': 'Google', 'gemini': 'Gemini', 'google-gemini': 'Gemini',
  'vertex': 'GoogleCloud', 'google-vertex': 'GoogleCloud', 'vertex-ai': 'GoogleCloud', 'gcp-vertex': 'GoogleCloud',
  'huggingface': 'HuggingFace', 'hugging-face': 'HuggingFace',
  'kilocode': 'KiloCode', 'kilo-code': 'KiloCode', 'kilo': 'KiloCode', 'kilo-gateway': 'KiloCode',
  'kimi': 'Kimi', 'kimi-coding': 'Kimi', 'kimi-coding-cn': 'Kimi',
  'lmstudio': 'LMStudio', 'lm-studio': 'LMStudio',
  'meta': 'Meta', 'meta-llama': 'Meta', 'meta-ai': 'Meta',
  'minimax': 'MiniMax', 'minimax-cn': 'MiniMax', 'minimax-oauth': 'MiniMax',
  'mistral': 'Mistral', 'mistralai': 'Mistral',
  'moa': 'TogetherAI',
  'nous': 'Nous',
  'nvidia': 'NVIDIA',
  'novita': 'Novita', 'novita-ai': 'Novita', 'novitaai': 'Novita',
  'ollama': 'Ollama', 'ollama-cloud': 'Ollama',
  'openai': 'OpenAI', 'openai-api': 'OpenAI', 'openai-codex': 'Codex', 'chatgpt': 'OpenAI',
  'opencode': 'OpenCode', 'opencode-free': 'OpenCode', 'opencode-go': 'OpenCode', 'opencode-zen': 'OpenCode',
  'openrouter': 'OpenRouter', 'open-router': 'OpenRouter',
  'qwen': 'Qwen', 'qwen-oauth': 'Qwen',
  'stepfun': 'StepFun', 'step': 'StepFun', 'stepfun-coding-plan': 'StepFun',
  'tencent-tokenhub': 'TencentCloud',
  'upstage': 'Upstage', 'solar': 'Upstage',
  'x-ai': 'Grok', 'xai': 'Grok', 'xai-oauth': 'Grok', 'grok': 'Grok',
  'xiaomi': 'Xiaomi',
  'zai': 'ZAI', 'z-ai': 'ZAI', 'glm': 'ZAI',
}

/** Icons drawn in their own colours, as the App's default `color` style draws them; the rest take the text colour. */
const COLOR = new Set(['Alibaba', 'Anthropic', 'Arcee', 'AWS', 'AzureAI', 'Codex', 'DeepInfra', 'DeepSeek', 'Fireworks', 'Gemini', 'Google', 'GoogleCloud', 'HuggingFace', 'Kimi', 'LMStudio', 'Meta', 'MiniMax', 'Mistral', 'NVIDIA', 'Nous', 'Novita', 'Qwen', 'StepFun', 'TencentCloud', 'TogetherAI', 'Upstage', 'Xiaomi', 'ZAI'])

/** Up to two initials of the provider's display name, as the App's fallback draws them. */
function initials(label: string): string {
  return label.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || '?'
}

/** A provider group's icon: its asset, or none for an unknown provider or a `custom:` endpoint, and its name's initials. */
export function providerIcon(providerId: string, label: string): ProviderIcon {
  const id = providerId.trim().toLowerCase()
  const asset = id && !id.startsWith('custom:') ? ASSETS[id] ?? null : null
  return { asset, initials: initials(label), color: asset !== null && COLOR.has(asset) }
}
