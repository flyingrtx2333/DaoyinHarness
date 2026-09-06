import type { ImgHTMLAttributes } from "react";
import harnessLogo from "../../public/assets/harness-logo.png";

/** Use the selected Aurora Fold redraw resource in every workbench placement. */
export function HarnessLogo({ className, alt = "", ...props }: ImgHTMLAttributes<HTMLImageElement>): React.JSX.Element {
  return <img {...props} className={["harness-logo", className].filter(Boolean).join(" ")} src={harnessLogo} alt={alt} draggable={false} />;
}
