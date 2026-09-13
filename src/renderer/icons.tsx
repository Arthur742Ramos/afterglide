import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { name: IconName };
export type IconName =
  | "home"
  | "pulse"
  | "settings"
  | "console"
  | "wifi"
  | "play"
  | "refresh"
  | "copy"
  | "external"
  | "back"
  | "power"
  | "check"
  | "warning"
  | "shield"
  | "display"
  | "controller";

const paths: Record<IconName, React.ReactNode> = {
  home: <path d="m3 11 9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  pulse: <path d="M3 12h4l2.2-6 4.1 12 2.2-6H21" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  console: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M8 12h4m-2-2v4m6-3h.01m2 2h.01" />
    </>
  ),
  wifi: (
    <path d="M5 12.6a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01" />
  ),
  play: <path d="m8 5 11 7-11 7z" />,
  refresh: (
    <path d="M20 7v5h-5M4 17v-5h5m10.5-2A8 8 0 0 0 6 6l-2 3m.5 5A8 8 0 0 0 18 18l2-3" />
  ),
  copy: <path d="M8 8h11v11H8zM5 16H4V4h12v1" />,
  external: (
    <path d="M14 4h6v6m0-6-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  ),
  back: <path d="m15 18-6-6 6-6" />,
  power: <path d="M12 2v10m6.4-6.4a9 9 0 1 1-12.8 0" />,
  check: <path d="m5 12 4 4L19 6" />,
  warning: (
    <>
      <path d="M12 3 2.7 20h18.6z" />
      <path d="M12 9v4m0 3h.01" />
    </>
  ),
  shield: (
    <path d="M12 3 4 6v5c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6zM9 12l2 2 4-5" />
  ),
  display: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-4v4" />
    </>
  ),
  controller: (
    <path d="M8 7h8a5 5 0 0 1 4.7 3.3l1.1 3.4a3 3 0 0 1-5.1 3L15 15H9l-1.7 1.7a3 3 0 0 1-5.1-3l1.1-3.4A5 5 0 0 1 8 7Zm-2 4v4m-2-2h4m9-1h.01m2 2h.01" />
  ),
};

export function Icon({ name, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
