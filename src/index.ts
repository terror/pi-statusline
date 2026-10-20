import type {
  ExtensionAPI,
  SessionEntry,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const BRANCH_SYMBOL = '\uE0A0';
const MIN_PADDING = 2;

export interface Statusline {
  branch: string | null;
  cost: number;
  model: string | null;
  provider: string | null;
  providerCount: number;
  pwd: string;
  sessionName: string | null;
  thinkingLevel: string | null;
  width: number;
}

export function sessionCost(entries: readonly SessionEntry[]): number {
  return entries.reduce((cost, entry) => {
    switch (entry.type) {
      case 'branch_summary':
      case 'compaction':
      case 'usage':
        return cost + (entry.usage?.cost.total ?? 0);
      case 'message':
        return entry.message.role === 'assistant' ||
          entry.message.role === 'toolResult'
          ? cost + (entry.message.usage?.cost.total ?? 0)
          : cost;
      case 'context_edit':
      case 'custom':
      case 'custom_message':
      case 'label':
      case 'model_change':
      case 'session_info':
      case 'thinking_level_change':
        return cost;
    }
  }, 0);
}

export function formatCwd(cwd: string, home: string | undefined): string {
  if (home === undefined || home === '') {
    return cwd;
  }
  const resolvedCwd = resolve(cwd);

  const resolvedHome = resolve(home);

  const relativeToHome = relative(resolvedHome, resolvedCwd);

  const isInsideHome =
    relativeToHome === '' ||
    (relativeToHome !== '..' &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  return isInsideHome
    ? relativeToHome === ''
      ? '~'
      : `~${sep}${relativeToHome}`
    : cwd;
}

function buildLeft({ pwd, branch, sessionName, cost }: Statusline): string {
  let left = pwd;

  if (branch !== null && branch !== '') {
    left += ` [${branch} ${BRANCH_SYMBOL}]`;
  }

  if (sessionName !== null && sessionName !== '') {
    left += ` • ${sessionName}`;
  }

  if (cost > 0) {
    left += ` ($${cost.toFixed(3)})`;
  }

  return left;
}

function buildRight({
  model,
  thinkingLevel,
  provider,
  providerCount,
}: Statusline): string {
  let right = model ?? 'no-model';

  if (thinkingLevel !== null && thinkingLevel !== '') {
    right +=
      thinkingLevel === 'off' ? ' • thinking off' : ` • ${thinkingLevel}`;
  }

  return provider !== null && provider !== '' && providerCount > 1
    ? `(${provider}) ${right}`
    : right;
}

export function renderStatusline(
  statusline: Statusline,
  theme: Pick<Theme, 'fg'>
): string {
  let left = theme.fg('dim', buildLeft(statusline));

  let leftWidth = visibleWidth(left);

  if (leftWidth > statusline.width) {
    left = truncateToWidth(left, statusline.width, theme.fg('dim', '...'));
    leftWidth = visibleWidth(left);
  }

  const right = theme.fg('dim', buildRight(statusline));

  const availableForRight = statusline.width - leftWidth - MIN_PADDING;

  if (availableForRight <= 0) {
    return left;
  }

  const shownRight =
    visibleWidth(right) > availableForRight
      ? truncateToWidth(right, availableForRight, '')
      : right;

  const padding = ' '.repeat(
    Math.max(0, statusline.width - leftWidth - visibleWidth(shownRight))
  );

  return left + theme.fg('dim', padding) + shownRight;
}

function sanitizeStatus(text: string): string {
  return text
    .replace(/[\r\n\t]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return;
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

      const usageCache: {
        sessionManager: typeof ctx.sessionManager;
        leafId: string | null;
        entryCount: number;
        cost: number;
      } = {
        sessionManager: ctx.sessionManager,
        leafId: null,
        entryCount: -1,
        cost: 0,
      };

      return {
        dispose: unsubscribe,
        invalidate() {
          return;
        },
        render(width: number): string[] {
          const sessionManager = ctx.sessionManager;

          const entries = sessionManager.getEntries();

          const leafId = sessionManager.getLeafId();

          if (
            usageCache.sessionManager !== sessionManager ||
            usageCache.leafId !== leafId ||
            usageCache.entryCount !== entries.length
          ) {
            usageCache.sessionManager = sessionManager;
            usageCache.leafId = leafId;
            usageCache.entryCount = entries.length;
            usageCache.cost = sessionCost(entries);
          }

          const model = ctx.model;

          const home = process.env.HOME;

          const line = renderStatusline(
            {
              width,
              pwd: formatCwd(
                sessionManager.getCwd(),
                home !== undefined && home !== ''
                  ? home
                  : process.env.USERPROFILE
              ),
              branch: footerData.getGitBranch(),
              sessionName: sessionManager.getSessionName() ?? null,
              cost: usageCache.cost,
              model: model?.id ?? null,
              thinkingLevel:
                model?.reasoning === true ? (ctx.thinkingLevel ?? 'off') : null,
              provider: model?.provider ?? null,
              providerCount: footerData.getAvailableProviderCount(),
            },
            theme
          );

          const lines = [line];

          const statuses = footerData.getExtensionStatuses();

          if (statuses.size > 0) {
            const statusLine = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => sanitizeStatus(text))
              .join(' ');

            lines.push(
              truncateToWidth(statusLine, width, theme.fg('dim', '...'))
            );
          }

          return lines;
        },
      };
    });
  });
}
