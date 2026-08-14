type ChevronIconProps = {
  direction?: "up" | "down" | "left" | "right";
  size?: number;
  className?: string;
};

const POINTS: Record<NonNullable<ChevronIconProps["direction"]>, string> = {
  up: "3 7.5 6 4.5 9 7.5",
  down: "3 4.5 6 7.5 9 4.5",
  left: "7.5 3 4.5 6 7.5 9",
  right: "4.5 3 7.5 6 4.5 9",
};

export default function ChevronIcon({
  direction = "down",
  size = 16,
  className,
}: ChevronIconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <polyline
        points={POINTS[direction]}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
