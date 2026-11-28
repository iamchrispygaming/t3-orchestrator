// Line icons, after the dashboard prototype.
const paths = {
  home: 'M3 10.5 12 3l9 7.5V21H3z M9 21v-6h6v6',
  ticket: 'M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z M14 7v10',
  bot: 'M4 8h16v11H4z M12 4v4 M9 13h.01 M15 13h.01',
  chat: 'M4 5h16v11H9l-5 4z',
  pulse: 'M3 12h4l3-7 4 14 3-7h4',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1 7 17 M17 7l2.1-2.1',
  term: 'M3 4h18v16H3z M7 9l3 3-3 3 M13 15h4',
  pr: 'M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5 M6 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5 M18 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5 M6 8.5v7 M18 15.5V10a3 3 0 0 0-3-3h-4 M13 5l-2 2 2 2',
  close: 'M6 6l12 12 M18 6 6 18',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} flex-none`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function AgentIcon({ agent }: { agent: 'claude' | 'codex' }) {
  const style = agent === 'codex' ? 'bg-blue-500/15 text-blue-300' : 'bg-orange-400/15 text-orange-300';
  return (
    <span className={`grid size-9 flex-none place-items-center rounded-lg ${style}`}>
      <Icon name={agent === 'codex' ? 'term' : 'bot'} />
    </span>
  );
}
