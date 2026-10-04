import type { Ref } from "react";

interface TerrariumCanvasProps {
  ref: Ref<HTMLDivElement>;
}

/** Host element for the PixiJS canvas. PixiJS owns everything inside it. */
export default function TerrariumCanvas({ ref }: TerrariumCanvasProps) {
  return <div ref={ref} className="terrarium" />;
}
