import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 border border-brand-700/60 shadow-sm",
  secondary: "bg-white text-slate-700 border border-line-strong hover:bg-surface-muted hover:border-slate-400",
  ghost: "text-slate-600 hover:bg-surface-sunken hover:text-slate-900",
  danger: "bg-white text-red-700 border border-red-300 hover:bg-red-50",
  subtle: "bg-brand-50 text-brand-700 border border-brand-100 hover:bg-brand-100",
};
const sizes: Record<Size, string> = { sm: "h-7 px-2.5 text-xs gap-1.5", md: "h-8 px-3 text-[13px] gap-2" };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...props }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-55",
        variants[variant], sizes[size], className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});
