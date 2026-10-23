type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const COLORS: Record<LogLevel, string> = {
  info: '\x1b[36m',  // cyan
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
  debug: '\x1b[90m', // gray
};

const RESET = '\x1b[0m';

function timestamp(): string {
  return new Date().toISOString();
}

function format(level: LogLevel, msg: string): string {
  return `${COLORS[level]}[${timestamp()}] [${level.toUpperCase()}]${RESET} ${msg}`;
}

function write(level: LogLevel, msg: string, ...args: unknown[]): void {
  const line = format(level, msg);
  if (level === 'error') {
    console.error(line, ...args);
  } else if (level === 'warn') {
    console.warn(line, ...args);
  } else {
    console.log(line, ...args);
  }
}

export const logger = {
  info: (msg: string, ...args: unknown[]) => write('info', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => write('warn', msg, ...args),
  error: (msg: string, ...args: unknown[]) => write('error', msg, ...args),
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.DEBUG === '1' || process.env.DEBUG === 'true') {
      write('debug', msg, ...args);
    }
  },
};
