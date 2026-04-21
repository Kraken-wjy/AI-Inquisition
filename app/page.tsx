"use client";

import Image from "next/image";
import { PointerEvent, useEffect, useRef, useState } from "react";

type Verdict = "supported" | "hallucination" | "uncertain";
type StyleMode = "guarded" | "free";
type ShareStatus = "idle" | "shared" | "copied" | "failed";

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

type AuditResponse = {
  text: string;
  cached: boolean;
  modelInfo: {
    reviewers: Record<string, string>;
    styleMode: StyleMode;
  };
  reviews: ModelReview[];
  meta?: CostControlMeta;
};

type SampleCase = {
  title: string;
  text: string;
};

type ModelReview = {
  id: string;
  personaName: string;
  modelName: string;
  avatarUrl: string;
  oneLiner: string;
  longComment: string;
  modelId?: string;
  usedModel?: string;
  verdict?: Verdict;
  confidence?: number;
  styleSignature?: string;
};

type AuditErrorPayload = {
  error?: string;
};

const CARD_SPAN = 248;
const AUTO_SCROLL_SPEED = 0.33;
const CARD_TILTS = [-1.2, 0.8, -0.6, 1.1, -1.4, 0.9, -0.7, 1.2];
const REVIEW_CARD_TILTS = [-0.9, 0.7, -0.6, 0.95];
const DEMO_LATENCY_MS = 1800;
const API_REQUEST_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_AUDIT_TIMEOUT_MS ?? "18000");
const API_REQUEST_RETRIES = Math.max(0, Number(process.env.NEXT_PUBLIC_AUDIT_RETRIES ?? "1"));
const CLIENT_MAX_INPUT_CHARS = Number(process.env.NEXT_PUBLIC_MAX_INPUT_CHARS ?? "240");
const DEFAULT_AI_NOTICE = "AI 生成，仅供参考";

function isLikelyNetworkError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return (
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("load failed") ||
    normalized.includes("timeout") ||
    normalized.includes("aborted")
  );
}

function mapAuditRequestError(error: unknown): string {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return "当前网络离线，请先恢复网络连接后再试。";
  }

  if (!(error instanceof Error)) {
    return "请求失败，请检查配置后重试。";
  }

  const normalized = error.message.toLowerCase();
  if (normalized.includes("请求超时") || normalized.includes("timeout")) {
    return "请求超时：服务响应较慢，请稍后重试。";
  }
  if (
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("load failed")
  ) {
    return "无法连接到 /api/audit。请确认开发服务正在运行（npm run dev），并检查代理或浏览器插件是否拦截请求。";
  }

  return error.message || "请求失败，请检查配置后重试。";
}

async function requestAudit(text: string, styleMode: StyleMode): Promise<AuditResponse> {
  const attempts = API_REQUEST_RETRIES + 1;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, API_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text, styleMode }),
        signal: controller.signal,
      });

      const rawBody = await response.text();
      let parsed: (AuditResponse & AuditErrorPayload) | null = null;
      if (rawBody.trim()) {
        try {
          parsed = JSON.parse(rawBody) as AuditResponse & AuditErrorPayload;
        } catch {
          throw new Error(`接口返回了非 JSON 响应（HTTP ${response.status}）。`);
        }
      }

      if (!response.ok) {
        throw new Error(parsed?.error ?? `审判失败（HTTP ${response.status}），请稍后再试。`);
      }

      if (!parsed) {
        throw new Error("接口返回为空，请稍后再试。");
      }

      return parsed;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new Error(`请求超时（>${Math.round(API_REQUEST_TIMEOUT_MS / 1000)}s）`);
      } else {
        lastError = error;
      }

      const shouldRetry = attempt < attempts - 1 && isLikelyNetworkError(lastError);
      if (shouldRetry) {
        await wait(400 * (attempt + 1));
        continue;
      }

      throw lastError;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  throw (lastError instanceof Error ? lastError : new Error("请求失败，请稍后再试。"));
}

const HERO_PROMPTS = [
  "想知道这段话有没有幻觉？",
  "想让 AI 锐评一下？",
  "想快速核验一段 AI 回答？",
  "想比较不同模型谁更靠谱？",
  "交给 AI 审判庭吧",
];

const LOADING_PROMPTS = [
  "正在接住GPT接不住的用户",
  "正在拿走GPT最硬的那一刀",
  "正在一句话锁死版本",
  "正在讲一句可能会让你冷静一点的话",
  "正在让Gemini停止夸赞",
  "正在让Gemini停止给用户发奖",
  "正在轻轻的推一下用户",
  "正在很认真的说一句，不绕",
  "正在给你拆清楚",
  "正在给回复中加入emoji",
  "正在掰开了，揉碎了，给你一版更狠的",
  "正在给你一句底层判断（非常诚实）",
  "正在把GPT放在这里接住你",
];

const sampleCases: SampleCase[] = [
  {
    title: "鲁迅名句出处",
    text: "鲁迅在《狂人日记》里说：‘世上本没有路，走的人多了，也便成了路。’",
  },
  {
    title: "拿破仑的身高",
    text: "拿破仑只有一米五，所以才被称为矮个子皇帝。",
  },
  {
    title: "电灯泡发明史",
    text: "爱迪生一个人发明了世界上第一只电灯泡。",
  },
  {
    title: "北极熊与企鹅分布",
    text: "北极熊经常捕食南极的企鹅，所以它们是天敌。",
  },
  {
    title: "莎士比亚名句出处",
    text: "‘The ends justify the means’ 是莎士比亚写在《哈姆雷特》里的名句。",
  },
  {
    title: "维生素 C 与感冒",
    text: "每天大剂量补充维生素 C 可以百分之百预防感冒。",
  },
  {
    title: "季节与日地距离",
    text: "一年里最热的时候地球距离太阳最近，所以夏天更热。",
  },
  {
    title: "金鱼记忆时长",
    text: "金鱼只有 7 秒记忆，所以它们一直活在当下。",
  },
];

export default function Home() {
  const [input, setInput] = useState("");
  const [demoMode, setDemoMode] = useState(false);
  const [styleMode, setStyleMode] = useState<StyleMode>("guarded");
  const [showDebugControls, setShowDebugControls] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedText, setSubmittedText] = useState("");
  const [reviews, setReviews] = useState<ModelReview[] | null>(null);
  const [meta, setMeta] = useState<CostControlMeta | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rafRef = useRef<number | null>(null);
  const targetScrollRef = useRef(0);
  const currentScrollRef = useRef(0);
  const velocityRef = useRef(0);
  const draggingRef = useRef(false);
  const lastPointerXRef = useRef(0);
  const startPointerXRef = useRef(0);
  const dragDistanceRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onHomeScene = !isLoading && !reviews;

  useEffect(() => {
    const envEnabled = process.env.NEXT_PUBLIC_SHOW_DEBUG_CONTROLS === "1";
    const queryEnabled =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("debug") === "1";

    setShowDebugControls(envEnabled || queryEnabled);
  }, []);

  useEffect(() => {
    if (!onHomeScene) {
      return;
    }

    const animate = () => {
      if (!draggingRef.current) {
        targetScrollRef.current += velocityRef.current;
        velocityRef.current *= 0.95;
        targetScrollRef.current += AUTO_SCROLL_SPEED;
      }

      currentScrollRef.current += (targetScrollRef.current - currentScrollRef.current) * 0.1;

      const viewportWidth = viewportRef.current?.offsetWidth ?? 1;
      const totalWidth = sampleCases.length * CARD_SPAN;

      for (let index = 0; index < sampleCases.length; index += 1) {
        const card = cardRefs.current[index];
        if (!card) {
          continue;
        }

        let virtualX = index * CARD_SPAN - currentScrollRef.current;

        while (virtualX < -totalWidth / 2) {
          virtualX += totalWidth;
        }
        while (virtualX > totalWidth / 2) {
          virtualX -= totalWidth;
        }

        const progress = virtualX / (viewportWidth * 0.38);
        const absProgress = Math.abs(progress);
        const z = -Math.pow(absProgress, 1.7) * 450;
        const rotateY = progress * 36;
        const scale = 1 - Math.min(0.18, absProgress * 0.1);
        const opacity = 1 - Math.min(0.72, Math.pow(absProgress, 2) * 0.62);
        const rotateZ = CARD_TILTS[index % CARD_TILTS.length];

        card.style.transform = `translateX(${virtualX}px) translateZ(${z}px) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${scale})`;
        card.style.opacity = `${opacity}`;
        card.style.zIndex = `${Math.round(1000 - Math.abs(virtualX))}`;
      }

      rafRef.current = window.requestAnimationFrame(animate);
    };

    rafRef.current = window.requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, [onHomeScene]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    lastPointerXRef.current = event.clientX;
    startPointerXRef.current = event.clientX;
    dragDistanceRef.current = 0;
    velocityRef.current = 0;
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) {
      return;
    }

    const delta = event.clientX - lastPointerXRef.current;
    lastPointerXRef.current = event.clientX;
    dragDistanceRef.current = Math.max(
      dragDistanceRef.current,
      Math.abs(event.clientX - startPointerXRef.current),
    );

    targetScrollRef.current -= delta * 1.45;
    velocityRef.current = -delta * 0.5;
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
  };

  async function triggerAudit(nextText: string) {
    const cleaned = nextText.trim();

    if (!cleaned || isLoading) {
      return;
    }

    setInput(cleaned);
    setSubmittedText(cleaned);
    setError(null);
    setReviews(null);
    setMeta(null);
    setIsLoading(true);

    try {
      let payload: AuditResponse;

      if (demoMode) {
        await wait(DEMO_LATENCY_MS);
        payload = buildDemoAudit(cleaned, styleMode);
      } else {
        payload = await requestAudit(cleaned, styleMode);
      }

      setReviews(payload.reviews);
      setMeta(payload.meta ?? null);
    } catch (submitError) {
      setError(mapAuditRequestError(submitError));
    } finally {
      setIsLoading(false);
    }
  }

  const displayError =
    error && (error.includes("OPENROUTER_API_KEY") || error.includes("CRAZYROUTER_API_KEY"))
      ? "请先配置 API Key，再进行判断。"
      : error;

  function selectCase(sample: SampleCase) {
    setInput(sample.text);
    setError(null);
    inputRef.current?.focus();
  }

  return (
    <main className="min-h-screen bg-[#eceef1] text-[#171717]">
      <SceneHeader />

      {isLoading ? (
        <LoadingScene />
      ) : reviews ? (
        <ResultScene
          submittedText={submittedText}
          reviews={reviews}
          meta={meta}
          onRetry={() => {
            setReviews(null);
            setError(null);
            setMeta(null);
            inputRef.current?.focus();
          }}
        />
      ) : (
        <div className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col px-5 pb-8 pt-24 md:px-8 md:pt-26">
          <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center">
            <RotatingEncryptedText
              texts={HERO_PROMPTS}
              className="relative top-5 min-h-[52px] text-center text-[22px] leading-[1.35] tracking-[-0.01em] text-black/78 md:min-h-[68px] md:text-[30px]"
            />

            <div className="mt-5 w-full">
              {showDebugControls ? (
                <div className="mb-2 flex flex-wrap items-center justify-end gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-black/45">
                    <span>演示模式</span>
                    <button
                      type="button"
                      aria-pressed={demoMode}
                      onClick={() => {
                        setDemoMode((prev) => !prev);
                      }}
                      className={`relative h-5 w-10 rounded-full border transition ${
                        demoMode
                          ? "border-black/25 bg-black/80"
                          : "border-black/15 bg-white/70"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition ${
                          demoMode ? "left-[21px] bg-white" : "left-0.5 bg-black/45"
                        }`}
                      />
                    </button>
                  </label>

                  <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-black/45">
                    <span>风格模式</span>
                    <div className="inline-flex rounded-full border border-black/15 bg-white/70 p-0.5">
                      <button
                        type="button"
                        onClick={() => setStyleMode("guarded")}
                        className={`rounded-full px-2.5 py-1 text-[10px] transition ${
                          styleMode === "guarded"
                            ? "bg-black text-white"
                            : "text-black/55 hover:text-black/75"
                        }`}
                      >
                        不放开
                      </button>
                      <button
                        type="button"
                        onClick={() => setStyleMode("free")}
                        className={`rounded-full px-2.5 py-1 text-[10px] transition ${
                          styleMode === "free"
                            ? "bg-black text-white"
                            : "text-black/55 hover:text-black/75"
                        }`}
                      >
                        自由
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void triggerAudit(input);
                }}
              >
                <div className="flex items-center gap-3 rounded-xl border border-black/12 bg-white/75 px-3 py-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(event) => setInput(event.target.value.slice(0, CLIENT_MAX_INPUT_CHARS))}
                    maxLength={CLIENT_MAX_INPUT_CHARS}
                    placeholder="粘贴一段 AI 文本..."
                    className="h-11 flex-1 bg-transparent text-base text-[#2a2a2a] outline-none placeholder:text-black/35"
                  />
                  <button
                    type="submit"
                    disabled={isLoading || input.trim().length === 0}
                    className="rounded-lg border border-black/15 px-4 py-2 text-xs uppercase tracking-[0.14em] text-[#3c3c3c] transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:border-black/8 disabled:text-[#b0b0b0] disabled:hover:bg-transparent"
                  >
                    开始判断
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-black/42">
                  <p>{DEFAULT_AI_NOTICE}</p>
                  <p>
                    {input.length}/{CLIENT_MAX_INPUT_CHARS}
                  </p>
                </div>
              </form>

              {displayError ? (
                <div className="mt-3 w-full rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                  {displayError}
                </div>
              ) : null}
            </div>
          </section>

          <section className="relative mt-2">
            <div
              ref={viewportRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onPointerLeave={handlePointerUp}
              className="relative h-full min-h-[320px] cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing md:min-h-[360px] [perspective:1400px]"
            >
              <div className="pointer-events-none absolute inset-0 [transform-style:preserve-3d]">
                {sampleCases.map((sample, index) => (
                  <button
                    key={sample.title}
                    type="button"
                    ref={(element) => {
                      cardRefs.current[index] = element;
                    }}
                    onClick={() => {
                      selectCase(sample);
                    }}
                    className="pointer-events-auto absolute left-1/2 top-1/2 h-[280px] w-[220px] -translate-x-1/2 -translate-y-1/2 cursor-pointer overflow-hidden rounded-sm border border-black/8 bg-[#fafafa] p-4 text-left shadow-[0_8px_24px_rgba(0,0,0,0.08)] transition-[border-color,box-shadow] duration-200 hover:border-black/25 hover:shadow-[0_12px_34px_rgba(0,0,0,0.11)]"
                  >
                    <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.46),rgba(0,0,0,0.04))]" />
                    <div className="relative h-full">
                      <h2 className="mt-1 text-2xl leading-[1.3] tracking-[-0.03em] text-black/78">
                        {sample.title}
                      </h2>
                      <p className="mt-5 line-clamp-4 text-sm leading-6 text-black/65">{sample.text}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function SceneHeader() {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-start justify-between px-5 py-6 mix-blend-multiply md:px-9">
      <p className="text-[11px] uppercase tracking-[0.2em]">AI Inquisition</p>
      <div className="text-right text-[10px] uppercase tracking-[0.18em] text-[#9a9a9a]">
        <p>Issue 01</p>
        <p className="mt-1">Curated selection</p>
      </div>
    </header>
  );
}

function LoadingScene() {
  return (
    <section className="mx-auto flex min-h-screen w-full max-w-[1500px] items-center justify-center px-5 pt-24 md:px-8 md:pt-26">
      <div className="w-full max-w-xl text-center">
        <RotatingEncryptedText
          texts={LOADING_PROMPTS}
          randomize
          rotateEveryMs={1600}
          scrambleFrameMs={30}
          className="mx-auto text-[15px] uppercase tracking-[0.24em] text-black/45 md:text-[16px]"
        />
      </div>
    </section>
  );
}

function ResultScene({
  submittedText,
  reviews,
  meta,
  onRetry,
}: {
  submittedText: string;
  reviews: ModelReview[];
  meta: CostControlMeta | null;
  onRetry: () => void;
}) {
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");

  async function handleShare() {
    const shareText = buildShareText(submittedText, reviews);
    const sharePayload = {
      title: "AI 审判庭",
      text: shareText,
      url: typeof window !== "undefined" ? window.location.href : undefined,
    };
    const nav =
      typeof window !== "undefined"
        ? (window.navigator as Navigator & {
            share?: (data?: ShareData) => Promise<void>;
            clipboard?: Clipboard;
          })
        : null;

    try {
      if (nav?.share) {
        await nav.share(sharePayload);
        setShareStatus("shared");
      } else {
        if (!nav?.clipboard) {
          throw new Error("Clipboard API unavailable");
        }
        await nav.clipboard.writeText(shareText);
        setShareStatus("copied");
      }
    } catch {
      try {
        if (!nav?.clipboard) {
          throw new Error("Clipboard API unavailable");
        }
        await nav.clipboard.writeText(shareText);
        setShareStatus("copied");
      } catch {
        setShareStatus("failed");
      }
    }

    window.setTimeout(() => {
      setShareStatus("idle");
    }, 1800);
  }

  return (
    <section className="mx-auto h-[100svh] w-full max-w-[1500px] overflow-hidden px-5 pb-4 pt-20 md:px-8 md:pt-24">
      <div className="mx-auto flex h-full max-w-6xl flex-col">
        <div className="shrink-0">
          <p className="text-[10px] uppercase tracking-[0.2em] text-black/45">AI 审判结果</p>
          <p className="mt-2 max-w-4xl line-clamp-2 text-[19px] leading-[1.35] tracking-[-0.02em] text-black/80 md:text-[22px]">
            {submittedText}
          </p>
          <p className="mt-2 text-[11px] tracking-[0.08em] text-black/42">
            {meta?.aiNotice ?? DEFAULT_AI_NOTICE}
          </p>
        </div>

        <div className="mt-5 grid min-h-0 flex-1 grid-cols-2 gap-3 lg:grid-cols-4">
          {reviews.map((review, index) => (
            <div
              key={review.id}
              className="result-card-enter h-full w-full max-w-[250px] justify-self-center"
              style={{ animationDelay: `${index * 520}ms` }}
            >
              <article
                className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-black/10 bg-[#fafafa] p-3 shadow-[0_8px_20px_rgba(0,0,0,0.08)] md:p-4"
                style={{ transform: `rotate(${REVIEW_CARD_TILTS[index % REVIEW_CARD_TILTS.length]}deg)` }}
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border border-black/15 bg-white">
                    <Image
                      src={review.avatarUrl}
                      alt={review.modelName}
                      width={44}
                      height={44}
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div>
                    <p className="text-sm text-black/78">{review.personaName}</p>
                    <p className="text-[10px] uppercase tracking-[0.14em] text-black/45">
                      {review.modelName}
                    </p>
                  </div>
                </div>

                <p className="mt-3 line-clamp-3 text-[19px] leading-[1.28] tracking-[-0.01em] text-black/80 break-words [overflow-wrap:anywhere] md:text-[21px]">
                  {review.oneLiner}
                </p>
                <p className="mt-2 line-clamp-6 text-[13px] leading-5 text-black/62 break-words [overflow-wrap:anywhere] md:line-clamp-7">
                  {review.longComment}
                </p>
              </article>
            </div>
          ))}
        </div>

        <div
          className="result-card-enter mt-8 flex justify-center"
          style={{ animationDelay: `${reviews.length * 520 + 520}ms` }}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg border border-black/15 bg-white/70 px-4 py-2 text-xs uppercase tracking-[0.14em] text-black/65 transition hover:border-black/30"
            >
              再审一句
            </button>
            <button
              type="button"
              onClick={() => {
                void handleShare();
              }}
              className="rounded-lg border border-black/15 bg-white/70 px-4 py-2 text-xs uppercase tracking-[0.14em] text-black/65 transition hover:border-black/30"
            >
              {shareStatus === "copied"
                ? "已复制"
                : shareStatus === "shared"
                  ? "已调起分享"
                : shareStatus === "failed"
                  ? "复制失败"
                  : "分享结果"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function RotatingEncryptedText({
  texts,
  className,
  rotateEveryMs = 3600,
  scrambleFrameMs = 42,
  randomize = false,
}: {
  texts: string[];
  className?: string;
  rotateEveryMs?: number;
  scrambleFrameMs?: number;
  randomize?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [display, setDisplay] = useState(texts[0] ?? "");
  const previousIndexRef = useRef(0);
  const rotateTimerRef = useRef<number | null>(null);
  const scrambleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (texts.length <= 1) {
      return;
    }

    rotateTimerRef.current = window.setInterval(() => {
      setIndex((prev) => {
        if (!randomize) {
          return (prev + 1) % texts.length;
        }

        let next = prev;
        while (next === prev) {
          next = Math.floor(Math.random() * texts.length);
        }
        return next;
      });
    }, rotateEveryMs);

    return () => {
      if (rotateTimerRef.current) {
        window.clearInterval(rotateTimerRef.current);
      }
    };
  }, [texts, rotateEveryMs, randomize]);

  useEffect(() => {
    const target = texts[index] ?? "";
    if (previousIndexRef.current === index) {
      return;
    }
    previousIndexRef.current = index;

    if (scrambleTimerRef.current) {
      window.clearInterval(scrambleTimerRef.current);
    }

    const chars = Array.from(target);
    let frame = 0;

    scrambleTimerRef.current = window.setInterval(() => {
      frame += 1;
      const revealCount = Math.max(0, frame - 4);

      const next = chars
        .map((char, charIndex) => {
          if (shouldKeepChar(char) || charIndex < revealCount) {
            return char;
          }
          return randomCipherChar();
        })
        .join("");

      setDisplay(next);

      if (revealCount > chars.length + 2) {
        if (scrambleTimerRef.current) {
          window.clearInterval(scrambleTimerRef.current);
        }
        setDisplay(target);
      }
    }, scrambleFrameMs);

    return () => {
      if (scrambleTimerRef.current) {
        window.clearInterval(scrambleTimerRef.current);
      }
    };
  }, [index, texts, scrambleFrameMs]);

  return (
    <h1 aria-live="polite" className={className}>
      {display}
    </h1>
  );
}

function shouldKeepChar(char: string) {
  return /[\s，。！？、“”‘’：；,.!?'"()\[\]（）]/.test(char);
}

function randomCipherChar() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&";
  return chars[Math.floor(Math.random() * chars.length)];
}

async function wait(ms: number) {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function buildDemoAudit(text: string, styleMode: StyleMode): AuditResponse {
  const suspects = ["只有", "百分之百", "一定", "全部", "从来不", "唯一"];
  const hasAbsoluteClaim = suspects.some((word) => text.includes(word));

  const verdict: Verdict = hasAbsoluteClaim ? "hallucination" : "supported";
  const baseOneLiner = hasAbsoluteClaim
    ? "语气很满，证据还没跟上。"
    : "暂未发现明显硬伤。";
  const baseLongComment = hasAbsoluteClaim
    ? "这句包含绝对化表达，建议补充可复查来源后再下定论。"
    : "结论目前可接受，但建议补一条来源让判断更稳。";

  return {
    text,
    cached: false,
    modelInfo: {
      styleMode,
      reviewers: {
        opus: "demo/opus",
        gpt: "demo/gpt",
        gemini: "demo/gemini",
        deepseek: "demo/deepseek",
      },
    },
    meta: {
      aiNotice: DEFAULT_AI_NOTICE,
      requestId: "demo-mode",
      inputChars: text.length,
      maxInputChars: CLIENT_MAX_INPUT_CHARS,
      rateLimitRemaining: 999,
      rateLimitResetSec: 0,
      cacheEntries: 0,
      cacheHitRate: 0,
      cacheTtlSec: 0,
    },
    reviews: [
      {
        id: "opus",
        personaName: "不愿留下姓名的 Opus",
        modelName: "Claude Opus",
        avatarUrl: "/avatars/opus.png",
        verdict,
        oneLiner: hasAbsoluteClaim ? "这句像宣言，不像证据。" : baseOneLiner,
        longComment: baseLongComment,
        usedModel: "demo/opus",
      },
      {
        id: "gpt",
        personaName: "只给结论的 GPT 法官",
        modelName: "GPT",
        avatarUrl: "/avatars/gpt.png",
        verdict,
        oneLiner: hasAbsoluteClaim ? "断言强度偏高。" : baseOneLiner,
        longComment: baseLongComment,
        usedModel: "demo/gpt",
      },
      {
        id: "gemini",
        personaName: "礼貌但不松口的 Gemini",
        modelName: "Gemini",
        avatarUrl: "/avatars/gemini.png",
        verdict,
        oneLiner: hasAbsoluteClaim ? "信息密度够了，证据密度不够。" : baseOneLiner,
        longComment: baseLongComment,
        usedModel: "demo/gemini",
      },
      {
        id: "deepseek",
        personaName: "嘴很硬的 DeepSeek",
        modelName: "DeepSeek",
        avatarUrl: "/avatars/deepseek.png",
        verdict,
        oneLiner: hasAbsoluteClaim ? "这波是常识翻车。" : baseOneLiner,
        longComment: baseLongComment,
        usedModel: "demo/deepseek",
      },
    ],
  };
}

function buildShareText(submittedText: string, reviews: ModelReview[]) {
  const lines = [
    "AI 审判庭结果（AI 生成，仅供参考）",
    "",
    `待审文本：${submittedText}`,
    "",
    ...reviews.map(
      (review) =>
        `${review.personaName}\n一句话：${review.oneLiner}\n评价：${review.longComment}`,
    ),
  ];

  return lines.join("\n\n");
}
