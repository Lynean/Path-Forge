import {
  agentDecisionSchema,
  agentResultSchema,
  agentTurnInputSchema,
  type AgentEvent,
  type AgentFailureCode,
  type AgentFailureStatus,
  type AgentTurnInput,
  type ToolObservation,
} from "../contracts";
import type { ModelAdapter } from "../model/model-adapter";
import type { AgentTool, AgentToolStreamEvent, ToolRegistry } from "../tools/tool";
import { EmptyContextProvider, type AgentContextProvider } from "../context/context-provider";
import type { AgentRuntime } from "./agent-runtime";

export interface HarnessRunBudgets {
  maxModelTurns: number;
  maxToolCalls: number;
  maxRunDurationMs: number;
  maxToolDurationMs: number;
  /** How many times a malformed tool-argument call is fed back for the model to
   * self-correct before the run is stopped. */
  maxInvalidArgumentRetries: number;
  /** How many semantic tool execution errors are fed back for self-correction. */
  maxToolExecutionRetries: number;
  /** How many unavailable/hallucinated tool names are fed back for correction. */
  maxUnknownToolRetries: number;
}

/**
 * Optional compaction for bulky tool results. A run keeps every observation in
 * context so the model can reason over them, which is cheap normally (a few
 * hundred tokens) but unbounded on projects with many large files. When
 * configured, an observation larger than `maxCharacters` is replaced by a short
 * natural-language summary of what it contributed — but ONLY once it is no
 * longer the most recent result, so the output the model is actively reasoning
 * about is always verbatim (exact identifiers, exact tracebacks).
 */
export interface ObservationCompaction {
  maxCharacters: number;
  summarize: (input: {
    tool: string;
    arguments: Record<string, unknown>;
    output: unknown;
  }) => Promise<string>;
}

export interface HarnessOptions {
  model: ModelAdapter;
  tools: ToolRegistry;
  context?: AgentContextProvider;
  budgets?: Partial<HarnessRunBudgets>;
  observationCompaction?: ObservationCompaction;
  /** @deprecated Use budgets.maxModelTurns. */
  maxTurns?: number;
}

export const DEFAULT_HARNESS_RUN_BUDGETS: HarnessRunBudgets = {
  maxModelTurns: 12,
  maxToolCalls: 20,
  maxRunDurationMs: 120_000,
  maxToolDurationMs: 30_000,
  maxInvalidArgumentRetries: 2,
  maxToolExecutionRetries: 2,
  maxUnknownToolRetries: 2,
};

class RunStoppedError extends Error {
  constructor(
    readonly status: AgentFailureStatus,
    readonly code: AgentFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "RunStoppedError";
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function stoppedFromSignal(signal: AbortSignal): RunStoppedError {
  return signal.reason instanceof RunStoppedError
    ? signal.reason
    : new RunStoppedError("cancelled", "CANCELLED", "Run cancelled");
}

async function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw stoppedFromSignal(signal);

  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(stoppedFromSignal(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class AgentHarness implements AgentRuntime {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly budgets: HarnessRunBudgets;

  constructor(private readonly options: HarnessOptions) {
    const requested = options.budgets ?? {};
    this.budgets = {
      maxModelTurns: positiveInteger(
        "maxModelTurns",
        requested.maxModelTurns ?? options.maxTurns ?? DEFAULT_HARNESS_RUN_BUDGETS.maxModelTurns,
      ),
      maxToolCalls: positiveInteger(
        "maxToolCalls",
        requested.maxToolCalls ?? DEFAULT_HARNESS_RUN_BUDGETS.maxToolCalls,
      ),
      maxRunDurationMs: positiveInteger(
        "maxRunDurationMs",
        requested.maxRunDurationMs ?? DEFAULT_HARNESS_RUN_BUDGETS.maxRunDurationMs,
      ),
      maxToolDurationMs: positiveInteger(
        "maxToolDurationMs",
        requested.maxToolDurationMs ?? DEFAULT_HARNESS_RUN_BUDGETS.maxToolDurationMs,
      ),
      maxInvalidArgumentRetries: positiveInteger(
        "maxInvalidArgumentRetries",
        requested.maxInvalidArgumentRetries ?? DEFAULT_HARNESS_RUN_BUDGETS.maxInvalidArgumentRetries,
      ),
      maxToolExecutionRetries: positiveInteger(
        "maxToolExecutionRetries",
        requested.maxToolExecutionRetries ?? DEFAULT_HARNESS_RUN_BUDGETS.maxToolExecutionRetries,
      ),
      maxUnknownToolRetries: positiveInteger(
        "maxUnknownToolRetries",
        requested.maxUnknownToolRetries ?? DEFAULT_HARNESS_RUN_BUDGETS.maxUnknownToolRetries,
      ),
    };
  }

  /**
   * Replaces oversized results with a short summary of what they contributed,
   * skipping the most recent one (the model is still reasoning over it) and any
   * already compacted. Best-effort: a failed summary leaves the result verbatim,
   * since dropping evidence is worse than spending the tokens.
   */
  private async compactOlderObservations(observations: ToolObservation[]): Promise<void> {
    const compaction = this.options.observationCompaction;
    if (!compaction || observations.length < 2) return;
    for (const observation of observations.slice(0, -1)) {
      const record = observation as ToolObservation & { compacted?: boolean };
      if (record.compacted) continue;
      const serialized = JSON.stringify(observation.output ?? "");
      if (serialized.length <= compaction.maxCharacters) continue;
      try {
        const summary = await compaction.summarize({
          tool: observation.tool,
          arguments: observation.arguments,
          output: observation.output,
        });
        if (!summary.trim()) continue;
        observation.output = {
          compactedResult: summary.trim(),
          note: "Summary of an earlier large tool result; re-run the tool if exact content is needed.",
        };
        record.compacted = true;
      } catch {
        // keep the verbatim output
      }
    }
  }

  private async *executeToolEvents(
    tool: AgentTool,
    arguments_: Record<string, unknown>,
    runId: string,
    runSignal: AbortSignal,
  ): AsyncIterable<AgentToolStreamEvent> {
    const controller = new AbortController();
    const forwardRunStop = (): void => controller.abort(runSignal.reason);
    runSignal.addEventListener("abort", forwardRunStop, { once: true });
    const timer = setTimeout(() => {
      controller.abort(
        new RunStoppedError(
          "timed_out",
          "TOOL_TIMEOUT",
          `Tool ${tool.name} exceeded the ${this.budgets.maxToolDurationMs}ms limit`,
        ),
      );
    }, this.budgets.maxToolDurationMs);

    try {
      const context = { runId, signal: controller.signal };
      if (!tool.executeStream) {
        const output = await waitWithSignal(
          tool.execute(arguments_, context),
          controller.signal,
        );
        yield { type: "result", output };
        return;
      }

      const iterator = tool.executeStream(arguments_, context)[Symbol.asyncIterator]();
      try {
        while (true) {
          const item = await waitWithSignal(iterator.next(), controller.signal);
          if (item.done) break;
          yield item.value;
        }
      } finally {
        if (controller.signal.aborted) await iterator.return?.();
      }
    } finally {
      clearTimeout(timer);
      runSignal.removeEventListener("abort", forwardRunStop);
    }
  }

  async *runTurn(rawInput: AgentTurnInput): AsyncIterable<AgentEvent> {
    const parsedInput = agentTurnInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      yield {
        type: "failed",
        status: "policy_rejected",
        code: "INVALID_INPUT",
        message: parsedInput.error.message,
      };
      return;
    }

    const input = parsedInput.data;
    if (this.activeRuns.has(input.runId)) {
      yield {
        type: "failed",
        status: "failed",
        code: "RUN_ALREADY_ACTIVE",
        message: `Run ${input.runId} is already active`,
      };
      return;
    }

    const controller = new AbortController();
    this.activeRuns.set(input.runId, controller);
    const runTimer = setTimeout(() => {
      controller.abort(
        new RunStoppedError(
          "timed_out",
          "RUN_TIMEOUT",
          `Run exceeded the ${this.budgets.maxRunDurationMs}ms limit`,
        ),
      );
    }, this.budgets.maxRunDurationMs);

    const observations: ToolObservation[] = [];
    const toolCalls: string[] = [];
    const executedCallSignatures = new Set<string>();
    const warnedDuplicateSignatures = new Set<string>();
    const toolExecutionCounts = new Map<string, number>();
    let toolStateRevision = 0;
    let requestedToolCalls = 0;
    let invalidArgumentAttempts = 0;
    let toolExecutionErrorAttempts = 0;
    let unknownToolAttempts = 0;
    let resourcesFinished = false;
    const finishResources = async (): Promise<void> => {
      if (resourcesFinished) return;
      resourcesFinished = true;
      await this.options.tools.finishRun(input.runId);
    };

    yield { type: "run_started", runId: input.runId };

    try {
      if (controller.signal.aborted) throw stoppedFromSignal(controller.signal);
      const documents = await waitWithSignal(
        (this.options.context ?? new EmptyContextProvider()).load(input),
        controller.signal,
      );

      for (let turn = 1; turn <= this.budgets.maxModelTurns; turn += 1) {
        if (controller.signal.aborted) throw stoppedFromSignal(controller.signal);

        yield { type: "model_turn_started", turn };
        const availableToolDefinitions = this.options.tools
          .definitions()
          .filter((definition) => {
            const registered = this.options.tools.get(definition.name);
            if (registered?.maxCallsPerRun === undefined) return true;
            return (
              (toolExecutionCounts.get(registered.name) ?? 0) <
              registered.maxCallsPerRun
            );
          });
        const modelContext = {
          input,
          documents,
          tools: availableToolDefinitions,
          turn,
          observations,
          signal: controller.signal,
        };
        let rawDecision: unknown;
        let streamedText = false;
        if (this.options.model.streamDecision) {
          const iterator = this.options.model.streamDecision(modelContext)[Symbol.asyncIterator]();
          try {
            while (true) {
              const item = await waitWithSignal(iterator.next(), controller.signal);
              if (item.done) break;
              if (item.value.type === "text_delta") {
                streamedText = true;
                yield { type: "text_delta", content: item.value.content };
              } else {
                rawDecision = item.value.decision;
              }
            }
          } finally {
            if (controller.signal.aborted) await iterator.return?.();
          }
          if (!rawDecision) throw new Error("Model stream produced no decision");
        } else {
          rawDecision = await waitWithSignal(
            this.options.model.decide(modelContext),
            controller.signal,
          );
        }
        const decision = agentDecisionSchema.parse(rawDecision);

        if (decision.type === "final") {
          await finishResources();
          if (!streamedText) {
            yield { type: "text_delta", content: decision.response };
          }
          const result = agentResultSchema.parse({
            status: "completed",
            runId: input.runId,
            response: decision.response,
            proposedActions: decision.proposedActions,
            toolCalls,
            turns: turn,
          });
          yield { type: "completed", result };
          return;
        }

        requestedToolCalls += 1;
        if (requestedToolCalls > this.budgets.maxToolCalls) {
          throw new RunStoppedError(
            "budget_exceeded",
            "MAX_TOOL_CALLS_EXCEEDED",
            `Agent exceeded the ${this.budgets.maxToolCalls}-tool-call limit`,
          );
        }

        const tool = this.options.tools.get(decision.call.name);
        if (!tool) {
          unknownToolAttempts += 1;
          const available = this.options.tools
            .definitions()
            .map((definition) => definition.name)
            .join(", ");
          const message =
            `Tool ${decision.call.name} is not available in this turn. ` +
            `Use only one of: ${available || "(no tools)"}.`;
          if (unknownToolAttempts > this.budgets.maxUnknownToolRetries) {
            throw new RunStoppedError(
              "policy_rejected",
              "UNKNOWN_TOOL",
              `${message} (after ${this.budgets.maxUnknownToolRetries} retries)`,
            );
          }
          observations.push({
            toolCallId: decision.call.id,
            tool: decision.call.name,
            arguments: (decision.call.arguments ?? {}) as Record<string, unknown>,
            output: { error: "UNKNOWN_TOOL", message },
          });
          yield {
            type: "tool_rejected",
            tool: decision.call.name,
            code: "UNKNOWN_TOOL",
            message,
          };
          continue;
        }

        const parsedArguments = tool.inputSchema.safeParse(decision.call.arguments);
        if (!parsedArguments.success) {
          // Recoverable: feed the validation error back so the model can fix its
          // arguments and retry, bounded so a persistently-wrong model still stops.
          invalidArgumentAttempts += 1;
          const detail = `Invalid arguments for tool ${tool.name}: ${parsedArguments.error.message}`;
          if (invalidArgumentAttempts > this.budgets.maxInvalidArgumentRetries) {
            throw new RunStoppedError(
              "policy_rejected",
              "INVALID_TOOL_ARGUMENTS",
              `${detail} (after ${this.budgets.maxInvalidArgumentRetries} retries)`,
            );
          }
          const message = `${detail}. Fix the arguments to exactly match the tool's input schema (do not add extra keys) and call it again.`;
          const output = { error: "INVALID_TOOL_ARGUMENTS", message };
          observations.push({
            toolCallId: decision.call.id,
            tool: tool.name,
            arguments: (decision.call.arguments ?? {}) as Record<string, unknown>,
            output,
          });
          yield {
            type: "tool_rejected",
            tool: tool.name,
            code: "INVALID_TOOL_ARGUMENTS",
            message,
          };
          continue;
        }

        const previousToolExecutions = toolExecutionCounts.get(tool.name) ?? 0;
        if (
          tool.maxCallsPerRun !== undefined &&
          previousToolExecutions >= tool.maxCallsPerRun
        ) {
          const message =
            `${tool.name} already reached its ${tool.maxCallsPerRun}-call limit for this turn. ` +
            "Use the existing observation as evidence and answer the learner now.";
          observations.push({
            toolCallId: decision.call.id,
            tool: tool.name,
            arguments: parsedArguments.data,
            output: { error: "TOOL_CALL_LIMIT", message },
          });
          yield {
            type: "tool_rejected",
            tool: tool.name,
            code: "TOOL_CALL_LIMIT",
            message,
          };
          continue;
        }

        const callSignature = `${toolStateRevision}:${tool.name}:${canonicalize(parsedArguments.data)}`;
        if (executedCallSignatures.has(callSignature)) {
          const message = `The exact tool call ${tool.name}(${canonicalize(parsedArguments.data)}) already ran. Use its existing result or request different arguments.`;
          if (warnedDuplicateSignatures.has(callSignature)) {
            throw new RunStoppedError("budget_exceeded", "REPEATED_TOOL_CALL", message);
          }

          warnedDuplicateSignatures.add(callSignature);
          const output = { error: "DUPLICATE_TOOL_CALL", message };
          observations.push({
            toolCallId: decision.call.id,
            tool: tool.name,
            arguments: parsedArguments.data,
            output,
          });
          yield {
            type: "tool_rejected",
            tool: tool.name,
            code: "DUPLICATE_TOOL_CALL",
            message,
          };
          continue;
        }

        executedCallSignatures.add(callSignature);
        toolCalls.push(tool.name);
        yield { type: "tool_started", tool: tool.name, arguments: parsedArguments.data };
        let output: unknown;
        let receivedOutput = false;
        try {
          for await (const toolEvent of this.executeToolEvents(
            tool,
            parsedArguments.data,
            input.runId,
            controller.signal,
          )) {
            if (toolEvent.type === "progress") {
              yield {
                type: "tool_progress",
                tool: tool.name,
                stage: toolEvent.stage,
                message: toolEvent.message,
              };
            } else {
              output = toolEvent.output;
              receivedOutput = true;
            }
          }
        } catch (error) {
          if (error instanceof RunStoppedError || controller.signal.aborted) throw error;
          toolExecutionErrorAttempts += 1;
          const detail =
            error instanceof Error ? error.message : "Unknown tool execution error";
          const message =
            `Tool ${tool.name} rejected these arguments during execution: ${detail}. ` +
            "Correct the arguments or use the existing evidence; do not repeat the same call.";
          if (toolExecutionErrorAttempts > this.budgets.maxToolExecutionRetries) {
            throw new RunStoppedError(
              "policy_rejected",
              "INVALID_TOOL_ARGUMENTS",
              `${message} (after ${this.budgets.maxToolExecutionRetries} retries)`,
            );
          }
          observations.push({
            toolCallId: decision.call.id,
            tool: tool.name,
            arguments: parsedArguments.data,
            output: { error: "TOOL_EXECUTION_ERROR", message },
          });
          yield {
            type: "tool_rejected",
            tool: tool.name,
            code: "INVALID_TOOL_ARGUMENTS",
            message,
          };
          continue;
        }
        if (!receivedOutput) throw new Error(`Tool ${tool.name} produced no result`);
        const currentToolExecutions = previousToolExecutions + 1;
        toolExecutionCounts.set(tool.name, currentToolExecutions);
        const reachedToolLimit =
          tool.maxCallsPerRun !== undefined &&
          currentToolExecutions >= tool.maxCallsPerRun;
        const observationOutput = reachedToolLimit
          ? typeof output === "object" && output !== null && !Array.isArray(output)
            ? {
                ...(output as Record<string, unknown>),
                harnessInstruction:
                  `${tool.name} has completed and is no longer available this turn. ` +
                  "Answer the learner now using this exact evidence; do not request another run.",
              }
            : {
                result: output,
                harnessInstruction:
                  `${tool.name} has completed and is no longer available this turn. ` +
                  "Answer the learner now using this exact evidence; do not request another run.",
              }
          : output;
        observations.push({
          toolCallId: decision.call.id,
          tool: tool.name,
          arguments: parsedArguments.data,
          output: observationOutput,
        });
        if (tool.invalidatesPriorToolResults?.(output)) {
          toolStateRevision += 1;
        }
        // Now that a newer result exists, bulky older ones can be summarized —
        // the newest observation is always left verbatim.
        await this.compactOlderObservations(observations);
        yield { type: "tool_completed", tool: tool.name, output };
      }

      throw new RunStoppedError(
        "budget_exceeded",
        "MAX_MODEL_TURNS_EXCEEDED",
        `Agent exceeded the ${this.budgets.maxModelTurns}-model-turn limit`,
      );
    } catch (error) {
      let stopped =
        error instanceof RunStoppedError
          ? error
          : controller.signal.aborted
            ? stoppedFromSignal(controller.signal)
            : new RunStoppedError(
                "failed",
                "HARNESS_ERROR",
                error instanceof Error ? error.message : "Unknown harness error",
              );
      try {
        await finishResources();
      } catch (cleanupError) {
        stopped = new RunStoppedError(
          "failed",
          "HARNESS_ERROR",
          `Run cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "Unknown cleanup error"}`,
        );
      }
      yield {
        type: "failed",
        status: stopped.status,
        code: stopped.code,
        message: stopped.message,
      };
    } finally {
      if (!resourcesFinished) {
        try {
          await finishResources();
        } catch {
          // A terminal event may already have been emitted; cleanup is best-effort here.
        }
      }
      clearTimeout(runTimer);
      this.activeRuns.delete(input.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (active) {
      active.abort(new RunStoppedError("cancelled", "CANCELLED", "Run cancelled"));
    }
  }
}
