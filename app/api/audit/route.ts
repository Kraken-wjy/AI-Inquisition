import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const maxDuration = 30;

type Verdict = "supported" | "hallucination" | "uncertain";

type JudgeResult = {
  judge: "fact-check" | "roast";
  verdict: Verdict;
  title: string;
  summary: string;
  detail?: string;
  confidence?: number;
  oneLiner?: string;
  longComment?: string;
  styleSignature?: string;
};

type ReviewCardResult = {
  id: string;
  personaName: string;
  modelName: string;
  avatarUrl: string;
  modelId: string;
  usedModel: string;
  verdict: Verdict;
  oneLiner: string;
  longComment: string;
  confidence?: number;
  styleSignature?: string;
};

type AuditPayload = {
  text?: string;
  styleMode?: StyleMode;
};

type ProviderResult = {
  verdict?: Verdict | string | boolean | number;
  title?: string;
  summary?: string;
  detail?: string;
  confidence?: number | string;
  one_liner?: string;
  long_comment?: string;
  style_signature?: string;
};

type ParsedJudgeContent = {
  verdict: Verdict;
  title: string;
  summary: string;
  detail?: string;
  confidence?: number;
  oneLiner?: string;
  longComment?: string;
  styleSignature?: string;
};

type OpenRouterChoice = {
  message?: {
    content?: string;
  };
};

type OpenRouterResponse = {
  choices?: OpenRouterChoice[];
};

type ModelInfo = {
  reviewers: Record<string, string>;
  styleMode: StyleMode;
};

type CacheRecord = {
  createdAt: number;
  modelInfo: ModelInfo;
  reviews: ReviewCardResult[];
};

type RateLimitRecord = {
  count: number;
  resetAt: number;
};

type CostControlMeta = {
  aiNotice: string;
  requestId: string;
  inputChars: number;
  maxInputChars: number;
  rateLimitRemaining: number;
  rateLimitResetSec: number;
  cacheEntries: number;
  cacheHitRate: number;
  cacheTtlSec: number;
};

type JudgeFallbackOutcome = {
  usedModel: string;
  result: JudgeResult;
};

type RoastStyleProfile = {
  toneDirectives: string[];
  dictionDirectives: string[];
  structureDirectives: string[];
  signaturePhrases: string[];
  forbiddenPhrases: string[];
};

type RoastPromptContext = {
  model: string;
  text: string;
  styleMode: StyleMode;
};

type ReviewModelConfig = {
  id: string;
  personaName: string;
  modelName: string;
  avatarUrl: string;
  modelId: string;
  fallbackModelIds?: string[];
};

type StyleMode = "guarded" | "free";

const auditCache = new Map<string, CacheRecord>();
const rateLimitStore = new Map<string, RateLimitRecord>();
const CACHE_TTL_MS = 1000 * 60 * 10;
const DEFAULT_API_BASE_URL = "https://crazyrouter.com/v1";
const AI_NOTICE = "AI 生成，仅供参考";
const MAX_INPUT_CHARS = getPositiveInt(process.env.MAX_INPUT_CHARS, 240);
const RATE_LIMIT_WINDOW_MS = getPositiveInt(process.env.RATE_LIMIT_WINDOW_SECONDS, 600) * 1000;
const RATE_LIMIT_MAX_REQUESTS = getPositiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 24);
const REVIEW_TIMEOUT_MS = getPositiveInt(process.env.REVIEW_TIMEOUT_MS, 6500);
const REVIEW_MAX_RETRIES = getNonNegativeInt(process.env.REVIEW_MAX_RETRIES, 0);
const CACHE_MAX_ENTRIES = getPositiveInt(process.env.CACHE_MAX_ENTRIES, 180);
const REVIEW_MAX_TOKENS = getPositiveInt(process.env.REVIEW_MAX_TOKENS, 220);
let cacheHits = 0;
let cacheMisses = 0;

const REVIEW_MODEL_CONFIGS: ReviewModelConfig[] = [
  {
    id: "opus",
    personaName: "不愿留下姓名的 Opus",
    modelName: "Claude Opus",
    avatarUrl: "/avatars/opus.png",
    modelId: process.env.REVIEW_MODEL_OPUS ?? "claude-opus-4-7",
    fallbackModelIds: parseModelList(process.env.REVIEW_MODEL_OPUS_FALLBACKS, [
      "claude-opus-4-5",
      "claude-opus-4-1",
    ]),
  },
  {
    id: "gpt",
    personaName: "只给结论的 GPT 法官",
    modelName: "GPT",
    avatarUrl: "/avatars/gpt.png",
    modelId: process.env.REVIEW_MODEL_GPT ?? "gpt-4o-mini",
  },
  {
    id: "gemini",
    personaName: "礼貌但不松口的 Gemini",
    modelName: "Gemini",
    avatarUrl: "/avatars/gemini.png",
    modelId: process.env.REVIEW_MODEL_GEMINI ?? "gemini-2.5-flash-lite",
    fallbackModelIds: parseModelList(process.env.REVIEW_MODEL_GEMINI_FALLBACKS, [
      "gemini-2.5-flash",
    ]),
  },
  {
    id: "deepseek",
    personaName: "嘴很硬的 DeepSeek",
    modelName: "DeepSeek",
    avatarUrl: "/avatars/deepseek.png",
    modelId: process.env.REVIEW_MODEL_DEEPSEEK ?? "deepseek-v3",
  },
];

const EMPTY_STYLE_PROFILE: RoastStyleProfile = {
  toneDirectives: [],
  dictionDirectives: [],
  structureDirectives: [],
  signaturePhrases: [],
  forbiddenPhrases: [],
};

const GPT_SIGNATURE_POOL = ["先讲结论：", "这句先落锤：", "先给你压缩成一句：", "不绕，一句话总结："];

const ROAST_STYLE_PROFILES: Partial<Record<string, RoastStyleProfile>> = {
  gpt: {
    toneDirectives: ["稳定、笃定、克制，优先给清晰判断。", "自然中文，不要口号感，但可以有一点“压住场面”的劲。"],
    dictionDirectives: ["多用短句，避免情绪化和过度安慰。", "允许轻微口头禅，但不要机械复读。"],
    structureDirectives: ["先给结论，再给关键依据，最后补一句可执行建议。"],
    signaturePhrases: [
      "先讲结论：",
      "可验证结论是：",
      "关键依据是：",
      "不绕，一句话总结：",
      "这句先落锤：",
      "先给你压缩成一句：",
      "我给你一版最短判断：",
      "这句我会这样定性：",
      "如果只留一句话，那就是：",
    ],
    forbiddenPhrases: [
      "作为一个AI",
      "根据公开资料显示",
      "连续三句以上模板安抚",
      "我在这里，稳稳接住你",
      "人身攻击",
    ],
  },
  gemini: {
    toneDirectives: ["理性、清楚、克制友好。先给判定，再给解释。"],
    dictionDirectives: ["避免夸张赞美和情绪化句式，不要“打鸡血”开场。"],
    structureDirectives: ["先判定 -> 给两条关键依据 -> 给一条可修正建议。"],
    signaturePhrases: [
      "先给判定：",
      "关键信息是：",
      "更稳妥的说法是：",
      "证据不足时我会标记为 uncertain。",
    ],
    forbiddenPhrases: ["连续夸赞用户", "先夸再判", "人身攻击", "歧视性表达"],
  },
  "claude-opus": {
    toneDirectives: ["克制、准确、含一点审美感，不吵闹。"],
    dictionDirectives: ["避免网络梗，少感叹句，保持沉着。"],
    structureDirectives: ["一句话先盖章，再按“错位点 -> 为什么错 -> 怎么改”展开。"],
    signaturePhrases: [
      "先讲结论。",
      "这句话的问题不在立场，在证据。",
      "把它说得动听，不等于把它说对。",
      "你这句有锋利度，但证据还没跟上。",
      "如果要严谨，只需补一条可复查来源。",
    ],
    forbiddenPhrases: ["网络梗", "粗口", "过度表情符号", "人身攻击"],
  },
  deepseek: {
    toneDirectives: ["短、硬、直接，明确指出翻车点。"],
    dictionDirectives: ["使用直球技术流表达，避免绕弯。"],
    structureDirectives: ["一句话直接判，再按“核心错误 -> 反例/对照 -> 最终结论”展开。"],
    signaturePhrases: [
      "直说：这句翻车了。",
      "问题点就一个：",
      "这不是观点分歧，是事实错误。",
      "别绕，结论先放这。",
      "这波属于常识级误判。",
    ],
    forbiddenPhrases: ["人身攻击", "侮辱性词汇", "歧视性表达"],
  },
};

export async function POST(request: Request) {
  let payload: AuditPayload;
  const requestId = createRequestId();
  const clientKey = getClientKey(request);
  const rateStatus = consumeRateLimit(clientKey);

  try {
    payload = (await request.json()) as AuditPayload;
  } catch {
    return NextResponse.json(
      {
        error: "请求体不是合法 JSON。",
        meta: createCostControlMeta({
          requestId,
          inputChars: 0,
          rateLimitRemaining: rateStatus.remaining,
          rateLimitResetSec: rateStatus.resetSec,
        }),
      },
      { status: 400 },
    );
  }

  const text = payload.text?.trim();
  const styleMode = resolveStyleMode(payload.styleMode);

  if (!text) {
    return NextResponse.json(
      {
        error: "请先输入一段待审文本。",
        meta: createCostControlMeta({
          requestId,
          inputChars: 0,
          rateLimitRemaining: rateStatus.remaining,
          rateLimitResetSec: rateStatus.resetSec,
        }),
      },
      { status: 400 },
    );
  }

  if (!rateStatus.allowed) {
    return NextResponse.json(
      {
        error: `请求过于频繁，请在 ${rateStatus.resetSec} 秒后再试。`,
        meta: createCostControlMeta({
          requestId,
          inputChars: text.length,
          rateLimitRemaining: 0,
          rateLimitResetSec: rateStatus.resetSec,
        }),
      },
      { status: 429 },
    );
  }

  if (text.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      {
        error: `输入过长（${text.length} 字），请控制在 ${MAX_INPUT_CHARS} 字以内。`,
        meta: createCostControlMeta({
          requestId,
          inputChars: text.length,
          rateLimitRemaining: rateStatus.remaining,
          rateLimitResetSec: rateStatus.resetSec,
        }),
      },
      { status: 413 },
    );
  }

  const cacheKey = `${styleMode}::${text}`;
  const cached = auditCache.get(cacheKey);
  const isFresh = cached && Date.now() - cached.createdAt < CACHE_TTL_MS;

  if (isFresh) {
    cacheHits += 1;
    return NextResponse.json({
      text,
      cached: true,
      modelInfo: cached.modelInfo,
      reviews: cached.reviews,
      meta: createCostControlMeta({
        requestId,
        inputChars: text.length,
        rateLimitRemaining: rateStatus.remaining,
        rateLimitResetSec: rateStatus.resetSec,
      }),
    });
  }
  cacheMisses += 1;

  const apiKey = process.env.CRAZYROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  const apiBaseUrl = (
    process.env.CRAZYROUTER_BASE_URL ??
    process.env.LLM_API_BASE_URL ??
    process.env.OPENROUTER_BASE_URL ??
    DEFAULT_API_BASE_URL
  ).replace(/\/$/, "");

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "缺少 CRAZYROUTER_API_KEY（或 OPENROUTER_API_KEY）。先在 .env.local 里配置 Key，再重新发起审判。",
        meta: createCostControlMeta({
          requestId,
          inputChars: text.length,
          rateLimitRemaining: rateStatus.remaining,
          rateLimitResetSec: rateStatus.resetSec,
        }),
      },
      { status: 500 },
    );
  }

  try {
    const reviewOutcomes = await Promise.all(
      REVIEW_MODEL_CONFIGS.map((reviewConfig) =>
        buildReviewCard({
          apiKey,
          apiBaseUrl,
          text,
          styleMode,
          reviewConfig,
        }),
      ),
    );

    const reviewers = reviewOutcomes.reduce<Record<string, string>>((acc, item) => {
      acc[item.id] = item.usedModel;
      return acc;
    }, {});

    const modelInfo: ModelInfo = { reviewers, styleMode };

    auditCache.set(cacheKey, {
      createdAt: Date.now(),
      modelInfo,
      reviews: reviewOutcomes,
    });
    pruneCacheEntries();

    return NextResponse.json({
      text,
      cached: false,
      modelInfo,
      reviews: reviewOutcomes,
      meta: createCostControlMeta({
        requestId,
        inputChars: text.length,
        rateLimitRemaining: rateStatus.remaining,
        rateLimitResetSec: rateStatus.resetSec,
      }),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "模型调用失败，请稍后再试。",
        meta: createCostControlMeta({
          requestId,
          inputChars: text.length,
          rateLimitRemaining: rateStatus.remaining,
          rateLimitResetSec: rateStatus.resetSec,
        }),
      },
      { status: 500 },
    );
  }
}

async function buildReviewCard({
  apiKey,
  apiBaseUrl,
  text,
  styleMode,
  reviewConfig,
}: {
  apiKey: string;
  apiBaseUrl: string;
  text: string;
  styleMode: StyleMode;
  reviewConfig: ReviewModelConfig;
}): Promise<ReviewCardResult> {
  try {
    const outcome = await requestJudgeWithFallback({
      apiKey,
      apiBaseUrl,
      models: [reviewConfig.modelId, ...(reviewConfig.fallbackModelIds ?? [])],
      judge: "roast",
      input: text,
      maxTokens: REVIEW_MAX_TOKENS,
      getTemperature: (model) => getModelTemperature(model),
      getSystemPrompt: (model) =>
        buildRoastPrompt({
          model,
          text,
          styleMode,
        }),
    });

    const oneLiner = normalizeTextForCard(
      outcome.result.oneLiner?.trim() || outcome.result.summary?.trim(),
      "观点有冲击力，但证据位还需要补。",
      32,
    );
    const longComment = normalizeTextForCard(
      outcome.result.longComment?.trim() || outcome.result.detail?.trim(),
      "该模型本轮未给出稳定判词，先看其他法官意见。",
      220,
    );
    const flavored = applyPersonaFlavor(reviewConfig.id, oneLiner, longComment);

    return {
      ...reviewConfig,
      usedModel: outcome.usedModel,
      verdict: outcome.result.verdict,
      oneLiner: flavored.oneLiner,
      longComment: flavored.longComment,
      confidence: outcome.result.confidence,
      styleSignature: outcome.result.styleSignature,
    };
  } catch {
    return {
      ...reviewConfig,
      usedModel: reviewConfig.modelId,
      verdict: "uncertain",
      oneLiner: "该模型暂时离线，未能返回判词。",
      longComment: "当前通道繁忙，请稍后再试，或先参考其他模型结论。",
    };
  }
}

async function requestJudge({
  apiKey,
  apiBaseUrl,
  model,
  judge,
  input,
  systemPrompt,
  maxTokens,
  temperature,
}: {
  apiKey: string;
  apiBaseUrl: string;
  model: string;
  judge: JudgeResult["judge"];
  input: string;
  systemPrompt: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<JudgeResult> {
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timeoutController.abort();
  }, REVIEW_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(process.env.LLM_SITE_URL
          ? { "HTTP-Referer": process.env.LLM_SITE_URL }
          : process.env.OPENROUTER_SITE_URL
            ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL }
            : {}),
        ...(process.env.LLM_APP_NAME
          ? { "X-Title": process.env.LLM_APP_NAME }
          : process.env.OPENROUTER_APP_NAME
            ? { "X-Title": process.env.OPENROUTER_APP_NAME }
            : {}),
      },
      signal: timeoutController.signal,
      body: JSON.stringify({
        model,
        temperature: typeof temperature === "number" ? temperature : judge === "roast" ? 0.9 : 0.2,
        ...(typeof maxTokens === "number" ? { max_tokens: maxTokens } : {}),
        response_format: {
          type: "json_object",
        },
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: input,
          },
        ],
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`模型 ${model} 请求超时（>${Math.round(REVIEW_TIMEOUT_MS / 1000)}s）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`模型 ${model} 调用失败：${errorText}`);
  }

  const payload = (await response.json()) as OpenRouterResponse;
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(`模型 ${model} 没有返回可解析内容。`);
  }

  return {
    judge,
    ...parseJudgeResponse(content, judge),
  };
}

async function requestJudgeWithFallback({
  apiKey,
  apiBaseUrl,
  models,
  judge,
  input,
  systemPrompt,
  getSystemPrompt,
  maxTokens,
  getTemperature,
}: {
  apiKey: string;
  apiBaseUrl: string;
  models: string[];
  judge: JudgeResult["judge"];
  input: string;
  systemPrompt?: string;
  getSystemPrompt?: (model: string) => string;
  maxTokens?: number;
  getTemperature?: (model: string) => number | undefined;
}): Promise<JudgeFallbackOutcome> {
  const dedupedModels = Array.from(new Set(models.map((item) => item.trim()).filter(Boolean)));
  const failures: string[] = [];

  for (const model of dedupedModels) {
    const prompt = getSystemPrompt ? getSystemPrompt(model) : systemPrompt;
    if (!prompt) {
      failures.push(`模型 ${model} 缺少 system prompt。`);
      continue;
    }

    for (let attempt = 0; attempt <= REVIEW_MAX_RETRIES; attempt += 1) {
      try {
        const result = await requestJudge({
          apiKey,
          apiBaseUrl,
          model,
          judge,
          input,
          systemPrompt: prompt,
          maxTokens,
          temperature: getTemperature ? getTemperature(model) : undefined,
        });
        return {
          usedModel: model,
          result,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `模型 ${model} 调用失败（未知错误）`;
        const attemptLabel = `模型 ${model} 第 ${attempt + 1}/${REVIEW_MAX_RETRIES + 1} 次失败：${message}`;
        failures.push(attemptLabel);
        // 超时通常意味着通道拥堵，继续回退会明显拉长整次请求，先快速结束该卡片。
        if (message.includes("请求超时")) {
          break;
        }
      }
    }
  }

  throw new Error(`所有候选模型都调用失败：${failures.join(" | ") || "无可用错误详情"}`);
}

function parseJudgeResponse(content: string, judge: JudgeResult["judge"]): ParsedJudgeContent {
  const parsed = safeParseProviderResult(content);
  const oneLiner = parsed.one_liner?.trim() || parsed.summary?.trim();
  const longComment = parsed.long_comment?.trim() || parsed.detail?.trim() || undefined;
  const summary = judge === "roast" ? oneLiner : parsed.summary?.trim();
  const detail = judge === "roast" ? longComment : parsed.detail?.trim() || undefined;

  const verdict = normalizeVerdict(parsed.verdict);
  if (!oneLiner || oneLiner.length < 6) {
    throw new Error("模型返回结构化内容不完整：缺少 one_liner。");
  }
  if (!summary || summary.length < 6) {
    throw new Error("模型返回结构化内容不完整：缺少 summary。");
  }
  if (verdict === "uncertain" && typeof parsed.verdict !== "undefined") {
    throw new Error(`模型 verdict 无法识别：${String(parsed.verdict)}`);
  }

  return {
    verdict,
    title: parsed.title?.trim() || fallbackTitle(judge),
    summary,
    detail,
    confidence: normalizeConfidence(parsed.confidence),
    oneLiner,
    longComment,
    styleSignature: parsed.style_signature?.trim() || undefined,
  };
}

function safeParseProviderResult(content: string): ProviderResult {
  try {
    return JSON.parse(content) as ProviderResult;
  } catch {
    const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      return JSON.parse(fencedMatch[1]) as ProviderResult;
    }

    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = content.slice(firstBrace, lastBrace + 1);
      return JSON.parse(candidate) as ProviderResult;
    }

    throw new Error("No JSON object found in model response.");
  }
}

function normalizeVerdict(verdict?: ProviderResult["verdict"]): Verdict {
  if (typeof verdict === "boolean") {
    return verdict ? "supported" : "hallucination";
  }
  if (typeof verdict === "number") {
    if (verdict === 1) {
      return "supported";
    }
    if (verdict === 0) {
      return "hallucination";
    }
    return "uncertain";
  }

  const normalized = String(verdict ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "uncertain";
  }
  if (["supported", "support", "true", "yes", "y", "1", "正确", "成立", "是", "真"].includes(normalized)) {
    return "supported";
  }
  if (
    ["hallucination", "false", "no", "n", "0", "错误", "不成立", "否", "假", "幻觉", "不正确"].includes(
      normalized,
    )
  ) {
    return "hallucination";
  }
  if (["uncertain", "unknown", "maybe", "不确定", "未知", "存疑"].includes(normalized)) {
    return "uncertain";
  }

  return "uncertain";
}

function normalizeConfidence(confidence?: ProviderResult["confidence"]): number | undefined {
  const parsed =
    typeof confidence === "number"
      ? confidence
      : typeof confidence === "string"
        ? Number.parseFloat(confidence)
        : Number.NaN;

  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return Math.max(0, Math.min(1, parsed));
}

function fallbackTitle(judge: JudgeResult["judge"]) {
  return judge === "fact-check" ? "事实审判结果" : "一句话锐评";
}

function buildRoastPrompt(context: RoastPromptContext) {
  const styleProfile = resolveRoastStyleProfile(context.model);
  const isGpt = context.model.toLowerCase().includes("gpt");
  const isGemini = context.model.toLowerCase().includes("gemini");

  if (context.styleMode === "free") {
    return [
      "你是一个能做事实判断并输出风格化评论的 AI 法官。",
      "你可以自由决定语气和表达风格，但必须有明确立场。",
      "只输出 JSON，不要输出 Markdown。",
      `【原文】${context.text}`,
      'JSON 结构为 {"verdict":"supported|hallucination|uncertain","title":"短标题","one_liner":"一句话锐评","long_comment":"一段判词","style_signature":"可选，说明本次风格","confidence":0到1之间的小数}。',
      "one_liner 保持 12-24 字，long_comment 保持 80-140 字。",
      "禁止人身攻击、侮辱词或歧视表达。",
    ].join(" ");
  }

  return [
    "你是一个能做事实判断并输出风格化评论的 AI 法官。",
    "你需要独立判断原文是否存在事实问题，并给出自己的立场。",
    "只输出 JSON，不要输出 Markdown。",
    `【原文】${context.text}`,
    "【风格约束-语气】" + formatDirectiveBlock(styleProfile.toneDirectives),
    "【风格约束-措辞】" + formatDirectiveBlock(styleProfile.dictionDirectives),
    "【风格约束-结构】" + formatDirectiveBlock(styleProfile.structureDirectives),
    "【风格约束-口癖】" + formatDirectiveBlock(styleProfile.signaturePhrases),
    "【口癖使用规则】每次最多用 1 句口癖，且仅出现 1 次，不能在同一段里连续堆叠多句。",
    ...(isGpt ? ["【额外要求】你必须自然使用 1 句口癖，且只出现 1 次。"] : []),
    ...(isGemini
      ? [
          "【额外要求】不要开场夸赞用户；若证据不足或存在多个冲突版本，必须给 verdict=uncertain，不能强行下结论。",
          "【额外要求】如果问题涉及名言/引文/出处归属，只有在你能给出可核对的出处细节（作品名+原句片段）时才能判 supported，否则必须判 uncertain。",
          "【额外要求】判 supported 时，long_comment 里必须包含“依据：”字段并写出可核对线索；写不出就改判 uncertain。",
        ]
      : []),
    "【风格约束-禁用词】" + formatDirectiveBlock(styleProfile.forbiddenPhrases),
    'JSON 结构为 {"verdict":"supported|hallucination|uncertain","title":"短标题","one_liner":"一句话锐评","long_comment":"一段判词","style_signature":"可选，说明采用了哪类风格","confidence":0到1之间的小数}。',
    "one_liner 保持 12-24 字，long_comment 保持 80-140 字。",
    "如果 verdict=supported，请使用克制且略带傲慢的认可口吻；如果为 hallucination 或 uncertain，可以带锋芒但避免人身攻击。",
  ].join(" ");
}

function resolveRoastStyleProfile(model: string): RoastStyleProfile {
  const normalized = model.toLowerCase();

  for (const [key, profile] of Object.entries(ROAST_STYLE_PROFILES)) {
    if (!profile) {
      continue;
    }
    if (normalized.includes(key.toLowerCase())) {
      return profile;
    }
  }

  return EMPTY_STYLE_PROFILE;
}

function formatDirectiveBlock(directives: string[]) {
  if (directives.length === 0) {
    return "（待配置）";
  }

  return directives.map((directive) => `- ${directive}`).join(" ");
}

function normalizeTextForCard(raw: string | undefined, fallback: string, maxLength: number) {
  if (!raw) {
    return fallback;
  }

  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) {
    return fallback;
  }

  // 避免把服务报错、请求 ID 或超长无空格串直接展示到卡片里。
  if (/request id|model_not_found|service temporarily unavailable|^\{.*"error"/i.test(text)) {
    return fallback;
  }
  if (/here is the json requested|```/i.test(text)) {
    return fallback;
  }
  if (/[A-Za-z0-9_:\-./]{70,}/.test(text)) {
    return fallback;
  }

  if (text.length > maxLength) {
    return `${text.slice(0, maxLength - 1)}…`;
  }

  return text;
}

function resolveStyleMode(input?: string): StyleMode {
  if (input === "free" || input === "guarded") {
    return input;
  }

  const envMode = process.env.STYLE_MODE?.toLowerCase();
  if (envMode === "free" || envMode === "guarded") {
    return envMode;
  }

  return "guarded";
}

function getModelTemperature(model: string) {
  const normalized = model.toLowerCase();

  if (normalized.includes("gpt")) {
    return 0.72;
  }
  if (normalized.includes("gemini")) {
    return 0.45;
  }
  if (normalized.includes("claude-opus")) {
    return 0.62;
  }
  if (normalized.includes("deepseek")) {
    return 0.9;
  }

  return 0.8;
}

function getPositiveInt(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num) || num <= 0) {
    return fallback;
  }

  return num;
}

function getNonNegativeInt(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num) || num < 0) {
    return fallback;
  }

  return num;
}

function parseModelList(value: string | undefined, defaults: string[]) {
  if (!value) {
    return defaults;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : defaults;
}

function applyPersonaFlavor(cardId: string, oneLiner: string, longComment: string) {
  if (cardId !== "gpt") {
    return { oneLiner, longComment };
  }

  const merged = `${oneLiner} ${longComment}`.replace(/\s+/g, "");
  const hasSignature = GPT_SIGNATURE_POOL.some((phrase) =>
    merged.includes(phrase.replace(/[：:]/g, "").replace(/\s+/g, "")),
  );
  if (hasSignature) {
    return { oneLiner, longComment };
  }

  const phrase = GPT_SIGNATURE_POOL[Math.abs(oneLiner.length + longComment.length) % GPT_SIGNATURE_POOL.length];
  return {
    oneLiner: normalizeTextForCard(`${phrase}${oneLiner}`, oneLiner, 32),
    longComment,
  };
}

function getClientKey(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const userAgent = request.headers.get("user-agent")?.slice(0, 60) ?? "ua-unknown";
  return `${forwardedFor || realIp || "local"}::${userAgent}`;
}

function consumeRateLimit(clientKey: string) {
  const now = Date.now();

  for (const [key, record] of rateLimitStore.entries()) {
    if (record.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }

  const current = rateLimitStore.get(clientKey);
  if (!current || current.resetAt <= now) {
    const fresh: RateLimitRecord = {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    };
    rateLimitStore.set(clientKey, fresh);
    return {
      allowed: true,
      remaining: Math.max(0, RATE_LIMIT_MAX_REQUESTS - fresh.count),
      resetSec: Math.max(1, Math.ceil((fresh.resetAt - now) / 1000)),
    };
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      remaining: 0,
      resetSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  rateLimitStore.set(clientKey, current);
  return {
    allowed: true,
    remaining: Math.max(0, RATE_LIMIT_MAX_REQUESTS - current.count),
    resetSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getCacheHitRate() {
  const total = cacheHits + cacheMisses;
  if (total === 0) {
    return 0;
  }
  return Number((cacheHits / total).toFixed(3));
}

function createCostControlMeta({
  requestId,
  inputChars,
  rateLimitRemaining,
  rateLimitResetSec,
}: {
  requestId: string;
  inputChars: number;
  rateLimitRemaining: number;
  rateLimitResetSec: number;
}): CostControlMeta {
  return {
    aiNotice: AI_NOTICE,
    requestId,
    inputChars,
    maxInputChars: MAX_INPUT_CHARS,
    rateLimitRemaining,
    rateLimitResetSec,
    cacheEntries: auditCache.size,
    cacheHitRate: getCacheHitRate(),
    cacheTtlSec: Math.round(CACHE_TTL_MS / 1000),
  };
}

function pruneCacheEntries() {
  if (auditCache.size <= CACHE_MAX_ENTRIES) {
    return;
  }

  const sorted = [...auditCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  const overflow = auditCache.size - CACHE_MAX_ENTRIES;
  for (const [cacheKey] of sorted.slice(0, overflow)) {
    auditCache.delete(cacheKey);
  }
}
