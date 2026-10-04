import type { ReactNode, SVGProps } from 'react';

/** A small inline icon set (no icon font, no external requests). */
function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export const InboxIcon = () => (
  <Icon>
    <path d="M3 13h5l2 3h4l2-3h5" />
    <path d="M5 5h14l2 8v6H3v-6z" />
  </Icon>
);
export const TodayIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
    <text x="12" y="18.5" textAnchor="middle" fontSize="7" fill="currentColor" stroke="none">
      {new Date().getDate()}
    </text>
  </Icon>
);
export const UpcomingIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4M7 14h2M11 14h2M15 14h2M7 17h2M11 17h2" />
  </Icon>
);
export const TagIcon = () => (
  <Icon>
    <path d="M3 12V4h8l10 10-8 8z" />
    <circle cx="7.5" cy="7.5" r="1.2" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Icon>
);
export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const MoreIcon = () => (
  <Icon>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </Icon>
);
export const CalendarIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Icon>
);
export const FlagIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
  </Icon>
);
export const ChevronIcon = ({ open = false }: { open?: boolean }) => (
  <Icon className={`transition-transform ${open ? 'rotate-90' : ''}`}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);
export const MenuIcon = () => (
  <Icon>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Icon>
);
export const EditIcon = () => (
  <Icon>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </Icon>
);
export const LinkIcon = () => (
  <Icon>
    <path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" />
    <path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" />
  </Icon>
);
export const CopyIcon = () => (
  <Icon>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V4H4v12h4" />
  </Icon>
);
export const MoveIcon = () => (
  <Icon>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);
export const ArchiveIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v11h14V9M10 13h4" />
  </Icon>
);
export const StarIcon = ({ filled = false }: { filled?: boolean }) => (
  <Icon fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
  </Icon>
);
export const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" />
  </Icon>
);
export const SubtaskIcon = () => (
  <Icon>
    <path d="M6 4v10a3 3 0 0 0 3 3h9M14 13l4 4-4 4" />
  </Icon>
);
export const DescriptionIcon = () => (
  <Icon>
    <path d="M5 6h14M5 10h14M5 14h9" />
  </Icon>
);
export const ClockIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l3 2" />
  </Icon>
);
export const DeadlineIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
export const GripIcon = () => (
  <Icon>
    <circle cx="9" cy="6" r="1" />
    <circle cx="15" cy="6" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="9" cy="18" r="1" />
    <circle cx="15" cy="18" r="1" />
  </Icon>
);
