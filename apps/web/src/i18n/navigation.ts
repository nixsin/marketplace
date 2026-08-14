import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Locale-aware Link/useRouter/redirect — automatically prefix paths with
// the current locale so switching languages doesn't lose the current page.
export const { Link, redirect, usePathname, useRouter } =
  createNavigation(routing);
