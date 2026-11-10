import { Brandmark } from '../shell/Brandmark'
import { appUrl } from './appRoot'
import { cn } from '../ui/cn'

/**
 * The App's provider icons (`app/Talaria/Models/ProviderIconRegistry.swift`), served from `static/brand/providers/`.
 * Keyed only by a catalog `provider_id`; a model id is never read. `providerIcon.test.ts` keeps this table and the
 * SVGs equal to the App's.
 */
const PROVIDER_ICON_ASSETS: Readonly<Record<string, string>> = {
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
const PROVIDER_ICON_COLOR = new Set(['Alibaba', 'Anthropic', 'Arcee', 'AWS', 'AzureAI', 'Codex', 'DeepInfra', 'DeepSeek', 'Fireworks', 'Gemini', 'Google', 'GoogleCloud', 'HuggingFace', 'Kimi', 'LMStudio', 'Meta', 'MiniMax', 'Mistral', 'NVIDIA', 'Nous', 'Novita', 'Qwen', 'StepFun', 'TencentCloud', 'TogetherAI', 'Upstage', 'Xiaomi', 'ZAI'])

/** The asset for a catalog `provider_id`, or null for an unknown or custom endpoint. */
function providerIconAsset(providerId: string | null | undefined): string | null {
  const id = providerId?.trim().toLowerCase()
  if (!id || id.startsWith('custom:')) return null
  return PROVIDER_ICON_ASSETS[id] ?? null
}

/** Up to two initials of the provider's display name, as the App's fallback draws them. */
function providerInitials(label: string): string {
  return label.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || '?'
}

/** A provider's icon, or its initials in a tinted circle; decorative, so the surrounding control carries the name. */
export function ProviderIcon({ providerId, label, className }: { providerId: string | null | undefined; label: string; className?: string | undefined }) {
  const asset = providerIconAsset(providerId)
  const box = cn('inline-flex size-4 shrink-0 items-center justify-center', className)
  if (!asset) return <span data-provider-icon="initials" aria-hidden="true" className={cn(box, 'rounded-full bg-hover text-[8px] font-bold leading-none')}>{providerInitials(label)}</span>
  const src = `static/brand/providers/${asset}.svg`
  if (PROVIDER_ICON_COLOR.has(asset)) return <img data-provider-icon={asset} src={appUrl(src).href} alt="" aria-hidden="true" className={cn(box, 'object-contain')} />
  return <Brandmark data-provider-icon={asset} src={src} className={box} />
}
