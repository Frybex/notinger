import type { ReactNode } from 'react'

const shapes: Record<string, ReactNode> = {
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  pencil: (
    <>
      <path d="M12 20h9" />
      <path d="M16.6 3.6a2.1 2.1 0 0 1 3 3L7 19.2 3 20.2l1-4Z" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M6 15H5.5A1.5 1.5 0 0 1 4 13.5v-8A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V6" />
    </>
  ),
  folder: (
    <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v6.9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
  ),
  folderPlus: (
    <>
      <path d="M3 6.5a2 2 0 0 1 2-2h4l2 2H19a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 10.5v4.8" />
      <path d="M9.6 12.9h4.8" />
    </>
  ),
  folderMove: (
    <>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v6.9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
      <path d="M10 13h5.5" />
      <path d="m13.5 11 2 2-2 2" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9.5 7V5.4c0-.8.6-1.4 1.4-1.4h1.2c.8 0 1.4.6 1.4 1.4V7" />
      <path d="M6.5 7l.8 11.2c.06.9.82 1.6 1.72 1.6h4.96c.9 0 1.66-.7 1.72-1.6L16.5 7" />
    </>
  ),
  mark: (
    <>
      <path d="M5.5 17.5c4.5-10.5 8.5.8 13-9.3" />
      <circle cx="5.5" cy="17.5" r="2.2" />
      <circle cx="18.5" cy="8.2" r="2.2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  import: (
    <>
      <path d="M12 3v10" />
      <path d="m8 9 4 4 4-4" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  chevronLeft: <path d="m14.5 6.5-5 5.5 5 5.5" />,
  chevronRight: <path d="m9.5 6.5 5 5.5-5 5.5" />,
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  panelRight: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="3.5" />
      <path d="M14.5 4.5v15" />
    </>
  ),
  panelRightChevron: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="3.5" />
      <path d="M14.5 4.5v15" />
      <path d="m7.25 8.75 3.5 3.25-3.5 3.25" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.9 4.9 1.4 1.4" />
      <path d="m17.7 17.7 1.4 1.4" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.3 17.7-1.4 1.4" />
      <path d="m19.1 4.9-1.4 1.4" />
    </>
  )
}

type IconProps = {
  name: keyof typeof shapes | string
  size?: number
}

export default function Icon({ name, size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name]}
    </svg>
  )
}
