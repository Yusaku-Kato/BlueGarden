/** Subtle placeholder while a remembered login is being restored on startup. */
export default function RestoringIndicator() {
  return (
    <p className="restoring" role="status">
      復元中…
    </p>
  );
}
