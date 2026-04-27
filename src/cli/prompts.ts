import * as readline from "node:readline/promises";
import chalk from "chalk";

export interface MenuOption {
  key: string;
  label: string;
  description?: string;
}

const ESC = "\x1b";
const CTRL_C = "\x03";

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function clearLines(count: number): void {
  for (let i = 0; i < count; i++) {
    process.stdout.write(`${ESC}[2K`);
    if (i < count - 1) process.stdout.write(`${ESC}[1A`);
  }
  process.stdout.write(`\r`);
}

function renderMenu(
  question: string,
  options: MenuOption[],
  selected: number,
): number {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold(question) + chalk.dim("  (↑/↓ to move, enter to select)"));
  lines.push("");
  options.forEach((opt, i) => {
    const active = i === selected;
    const marker = active ? chalk.cyan("❯") : " ";
    const label = active ? chalk.cyan.bold(opt.label) : chalk.bold(opt.label);
    const desc = opt.description ? chalk.dim(` — ${opt.description}`) : "";
    lines.push(`  ${marker} ${label}${desc}`);
  });
  lines.push("");
  process.stdout.write(lines.join("\n"));
  return lines.length;
}

async function pickOptionInteractive(
  question: string,
  options: MenuOption[],
  defaultIndex: number,
): Promise<MenuOption> {
  return new Promise<MenuOption>((resolve, reject) => {
    let selected = defaultIndex;
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    let lineCount = renderMenu(question, options, selected);

    const rerender = () => {
      clearLines(lineCount);
      lineCount = renderMenu(question, options, selected);
    };

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };

    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");

      if (s === CTRL_C) {
        cleanup();
        process.stdout.write("\n");
        reject(new Error("Cancelled"));
        return;
      }

      if (s === "\r" || s === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(options[selected]);
        return;
      }

      if (s === `${ESC}[A` || s === "k") {
        selected = (selected - 1 + options.length) % options.length;
        rerender();
        return;
      }

      if (s === `${ESC}[B` || s === "j") {
        selected = (selected + 1) % options.length;
        rerender();
        return;
      }

      // Numeric shortcut
      const n = parseInt(s, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= options.length) {
        selected = n - 1;
        rerender();
        return;
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function pickOptionFallback(
  question: string,
  options: MenuOption[],
  defaultIndex: number,
): Promise<MenuOption> {
  console.log();
  console.log(chalk.bold(question));
  console.log();
  options.forEach((opt, i) => {
    const marker = i === defaultIndex ? chalk.cyan("❯") : " ";
    const num = chalk.dim(`${i + 1})`);
    const desc = opt.description ? chalk.dim(` — ${opt.description}`) : "";
    console.log(`  ${marker} ${num} ${chalk.bold(opt.label)}${desc}`);
  });
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await rl.question(
        chalk.cyan(
          `? Choose [1-${options.length}] (default ${defaultIndex + 1}): `,
        ),
      )
    ).trim();
    let idx: number;
    if (!answer) {
      idx = defaultIndex;
    } else {
      idx = parseInt(answer, 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= options.length) {
        const byKey = options.findIndex(
          (o) => o.key.toLowerCase() === answer.toLowerCase(),
        );
        if (byKey === -1) {
          throw new Error(`Invalid selection: ${answer}`);
        }
        idx = byKey;
      }
    }
    return options[idx];
  } finally {
    rl.close();
  }
}

/**
 * Arrow-key picker. In a TTY, uses raw mode for ↑/↓ navigation with enter
 * to confirm. Falls back to a numbered prompt over pipes/ssh non-interactive.
 */
export async function pickOption(
  question: string,
  options: MenuOption[],
  opts: { defaultIndex?: number } = {},
): Promise<MenuOption> {
  if (options.length === 0) {
    throw new Error("pickOption: no options provided");
  }
  const defaultIndex = Math.max(
    0,
    Math.min(options.length - 1, opts.defaultIndex ?? 0),
  );

  if (isInteractive()) {
    return pickOptionInteractive(question, options, defaultIndex);
  }
  return pickOptionFallback(question, options, defaultIndex);
}

/** Free-text prompt with optional default. Returns "" if the user hits enter and no default is set. */
export async function promptText(
  question: string,
  defaultValue?: string,
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const suffix = defaultValue ? chalk.dim(` (default: ${defaultValue})`) : "";
    const answer = (
      await rl.question(chalk.cyan(`? ${question}${suffix}: `))
    ).trim();
    return answer || defaultValue || "";
  } finally {
    rl.close();
  }
}
