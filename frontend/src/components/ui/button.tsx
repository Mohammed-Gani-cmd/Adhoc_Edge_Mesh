import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "secondary" | "ghost" | "gradient" | "outline";
  size?: "default" | "sm" | "lg";
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant="default", size="default", ...props }, ref) => {
  const variants = {
    default: "bg-white text-slate-950 hover:bg-slate-100",
    secondary: "bg-slate-800 text-white hover:bg-slate-700",
    ghost: "text-slate-300 hover:bg-white/10 hover:text-white",
    gradient: "bg-gradient-to-b from-white via-white/95 to-slate-300 text-slate-950 hover:scale-[1.02] active:scale-[0.98]",
    outline: "border border-white/10 bg-white/[0.03] text-white hover:bg-white/[0.08]"
  };
  const sizes = { default: "h-10 px-4 text-sm", sm: "h-9 px-3 text-xs", lg: "h-11 px-6 text-sm" };
  return <button ref={ref} className={cn("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-50", variants[variant], sizes[size], className)} {...props} />;
});
Button.displayName = "Button";
export { Button };
