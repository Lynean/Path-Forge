import type { SandboxCommandRequest } from "../sandbox/agent-sandbox";

export type CommandPolicyRejectionCode =
  | "COMMAND_NOT_ALLOWED"
  | "ARGUMENTS_NOT_ALLOWED"
  | "WORKING_DIRECTORY_NOT_ALLOWED"
  | "ENVIRONMENT_NOT_ALLOWED"
  | "TIMEOUT_NOT_ALLOWED"
  | "OUTPUT_LIMIT_NOT_ALLOWED";

export type CommandPolicyDecision =
  | { allowed: true; request: SandboxCommandRequest }
  | { allowed: false; code: CommandPolicyRejectionCode; reason: string };

export interface CommandPolicy {
  evaluate(request: SandboxCommandRequest): CommandPolicyDecision;
}

export interface AllowlistedCommandPolicyOptions {
  packageManagers?: string[];
  scripts?: string[];
  maxTimeoutMs?: number;
  maxOutputCharacters?: number;
}

export interface ExactCommandPolicyOptions {
  commands: Array<{ command: string; arguments: string[] }>;
  maxTimeoutMs?: number;
  maxOutputCharacters?: number;
}

const DEFAULT_PACKAGE_MANAGERS = ["npm", "pnpm"];
const DEFAULT_SCRIPTS = ["test", "typecheck", "build"];

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function safeWorkingDirectory(value: string | undefined): boolean {
  if (value === undefined || value === ".") return true;
  if (value.length === 0 || value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(value) || value.includes("\\") || value.includes("\0")) return false;

  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      /^[a-zA-Z0-9._-]+$/.test(segment),
  );
}

/** Exact structured allowlist; it never asks a model or invokes a shell to decide. */
export class AllowlistedCommandPolicy implements CommandPolicy {
  private readonly packageManagers: Set<string>;
  private readonly scripts: Set<string>;
  private readonly maxTimeoutMs: number;
  private readonly maxOutputCharacters: number;

  constructor(options: AllowlistedCommandPolicyOptions = {}) {
    this.packageManagers = new Set(options.packageManagers ?? DEFAULT_PACKAGE_MANAGERS);
    this.scripts = new Set(options.scripts ?? DEFAULT_SCRIPTS);
    this.maxTimeoutMs = options.maxTimeoutMs ?? 120_000;
    this.maxOutputCharacters = options.maxOutputCharacters ?? 100_000;

    if (!positiveInteger(this.maxTimeoutMs)) {
      throw new Error("maxTimeoutMs must be a positive integer");
    }
    if (!positiveInteger(this.maxOutputCharacters)) {
      throw new Error("maxOutputCharacters must be a positive integer");
    }
  }

  evaluate(request: SandboxCommandRequest): CommandPolicyDecision {
    if (!this.packageManagers.has(request.command)) {
      return {
        allowed: false,
        code: "COMMAND_NOT_ALLOWED",
        reason: `Command is not allowlisted: ${request.command}`,
      };
    }

    const directScript =
      request.arguments.length === 1 && request.arguments[0] === "test"
        ? request.arguments[0]
        : undefined;
    const runScript =
      request.arguments.length === 2 && request.arguments[0] === "run"
        ? request.arguments[1]
        : undefined;
    const requestedScript = directScript ?? runScript;
    if (!requestedScript || !this.scripts.has(requestedScript)) {
      return {
        allowed: false,
        code: "ARGUMENTS_NOT_ALLOWED",
        reason: `Arguments are not an allowlisted package script: ${JSON.stringify(request.arguments)}`,
      };
    }

    if (!safeWorkingDirectory(request.workingDirectory)) {
      return {
        allowed: false,
        code: "WORKING_DIRECTORY_NOT_ALLOWED",
        reason: `Working directory must be a safe relative sandbox path: ${request.workingDirectory}`,
      };
    }

    if (request.environment && Object.keys(request.environment).length > 0) {
      return {
        allowed: false,
        code: "ENVIRONMENT_NOT_ALLOWED",
        reason: "Command-specific environment overrides are not allowed",
      };
    }

    if (!positiveInteger(request.timeoutMs) || request.timeoutMs > this.maxTimeoutMs) {
      return {
        allowed: false,
        code: "TIMEOUT_NOT_ALLOWED",
        reason: `Timeout must be between 1 and ${this.maxTimeoutMs}ms`,
      };
    }

    if (
      !positiveInteger(request.maxOutputCharacters) ||
      request.maxOutputCharacters > this.maxOutputCharacters
    ) {
      return {
        allowed: false,
        code: "OUTPUT_LIMIT_NOT_ALLOWED",
        reason: `Output limit must be between 1 and ${this.maxOutputCharacters} characters`,
      };
    }

    return { allowed: true, request };
  }
}

/** Exact executable-and-argument allowlist for ecosystems without package scripts. */
export class ExactCommandPolicy implements CommandPolicy {
  private readonly commands: Array<{ command: string; arguments: string[] }>;
  private readonly maxTimeoutMs: number;
  private readonly maxOutputCharacters: number;

  constructor(options: ExactCommandPolicyOptions) {
    this.commands = options.commands.map((entry) => ({
      command: entry.command,
      arguments: [...entry.arguments],
    }));
    this.maxTimeoutMs = options.maxTimeoutMs ?? 120_000;
    this.maxOutputCharacters = options.maxOutputCharacters ?? 100_000;
    if (this.commands.length === 0) throw new Error("commands must not be empty");
    if (!positiveInteger(this.maxTimeoutMs)) {
      throw new Error("maxTimeoutMs must be a positive integer");
    }
    if (!positiveInteger(this.maxOutputCharacters)) {
      throw new Error("maxOutputCharacters must be a positive integer");
    }
  }

  evaluate(request: SandboxCommandRequest): CommandPolicyDecision {
    const executableKnown = this.commands.some((entry) => entry.command === request.command);
    if (!executableKnown) {
      return {
        allowed: false,
        code: "COMMAND_NOT_ALLOWED",
        reason: `Command is not allowlisted: ${request.command}`,
      };
    }
    const exactMatch = this.commands.some(
      (entry) =>
        entry.command === request.command &&
        entry.arguments.length === request.arguments.length &&
        entry.arguments.every((argument, index) => argument === request.arguments[index]),
    );
    if (!exactMatch) {
      return {
        allowed: false,
        code: "ARGUMENTS_NOT_ALLOWED",
        reason: `Arguments are not an approved runtime recipe: ${JSON.stringify(request.arguments)}`,
      };
    }
    if (!safeWorkingDirectory(request.workingDirectory)) {
      return {
        allowed: false,
        code: "WORKING_DIRECTORY_NOT_ALLOWED",
        reason: `Working directory must be a safe relative sandbox path: ${request.workingDirectory}`,
      };
    }
    if (request.environment && Object.keys(request.environment).length > 0) {
      return {
        allowed: false,
        code: "ENVIRONMENT_NOT_ALLOWED",
        reason: "Command-specific environment overrides are not allowed",
      };
    }
    if (!positiveInteger(request.timeoutMs) || request.timeoutMs > this.maxTimeoutMs) {
      return {
        allowed: false,
        code: "TIMEOUT_NOT_ALLOWED",
        reason: `Timeout must be between 1 and ${this.maxTimeoutMs}ms`,
      };
    }
    if (
      !positiveInteger(request.maxOutputCharacters) ||
      request.maxOutputCharacters > this.maxOutputCharacters
    ) {
      return {
        allowed: false,
        code: "OUTPUT_LIMIT_NOT_ALLOWED",
        reason: `Output limit must be between 1 and ${this.maxOutputCharacters} characters`,
      };
    }
    return { allowed: true, request };
  }
}
