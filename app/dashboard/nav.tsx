"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = {
  href: string;
  label: string;
  icon: React.ReactNode;
};

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const ITEMS: Item[] = [
  {
    href: "/dashboard",
    label: "Hoy",
    icon: (
      <svg {...iconProps}>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9.5V21h14V9.5" />
      </svg>
    ),
  },
  {
    href: "/dashboard/turnos",
    label: "Turnos",
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </svg>
    ),
  },
  {
    href: "/dashboard/fichajes",
    label: "Fichajes",
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 3" />
      </svg>
    ),
  },
  {
    href: "/dashboard/operarios",
    label: "Operarios",
    icon: (
      <svg {...iconProps}>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
        <path d="M16.5 4.9a3.5 3.5 0 0 1 0 6.2M18.5 14.5c1.9 1 3 2.9 3 5.5" />
      </svg>
    ),
  },
  {
    href: "/dashboard/clientes",
    label: "Clientes",
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="7" width="18" height="14" rx="2" />
        <path d="M9 7V5a3 3 0 0 1 6 0v2M3 13h18" />
      </svg>
    ),
  },
  {
    href: "/dashboard/centros",
    label: "Centros",
    icon: (
      <svg {...iconProps}>
        <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" />
        <circle cx="12" cy="10" r="2.5" />
      </svg>
    ),
  },
];

export function DashboardNav({ horizontal = false }: { horizontal?: boolean }) {
  const pathname = usePathname();

  return (
    <nav
      className={
        horizontal
          ? "flex gap-1 overflow-x-auto"
          : "flex flex-col gap-1"
      }
    >
      {ITEMS.map((item) => {
        const active =
          item.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-gray-100 font-medium text-gray-900"
                : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
            } ${horizontal ? "shrink-0" : ""}`}
          >
            <span className={active ? "text-gray-900" : "text-gray-400"}>
              {item.icon}
            </span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
