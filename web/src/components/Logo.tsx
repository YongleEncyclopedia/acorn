/** Acorn mark, drawn in currentColor. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 6.4c-.2-1.8.5-3.2 2-4.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M7.3 14.6C7.3 9.7 11.2 6.6 16 6.6s8.7 3.1 8.7 8z" fill="currentColor" />
      <path
        d="M9.6 12.2l5.6-5.2M12.6 13.6l7-6.4M17 14l5.6-5.2M10 9.6l7.2 4.4M14.6 7.4l7.6 5.2"
        stroke="var(--bg-sidebar, #fff)"
        strokeOpacity=".35"
        strokeWidth=".9"
      />
      <rect x="6.2" y="13.6" width="19.6" height="2.6" rx="1.3" fill="currentColor" />
      <path d="M8.6 16.2c0 6.3 3.4 10.3 7.4 11.6 4-1.3 7.4-5.3 7.4-11.6z" fill="currentColor" fillOpacity=".55" />
    </svg>
  );
}
