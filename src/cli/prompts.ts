import * as readline from "node:readline/promises";
import chalk from "chalk";

export interface MenuOption {
  key: string;
  label: string;
  description?: string;
}

/**
 * Numbered-menu picker. Prints the options once, reads the number back,
 * and returns the selected MenuOption. No fancy keybindings — keeps the
 * CLI dependency-free and predictable over pipes/ssh.
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
        // Also accept the option's `key` as a shortcut.
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
