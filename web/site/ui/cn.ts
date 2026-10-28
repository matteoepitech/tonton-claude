// Class names for the components: later Tailwind classes win over earlier ones, as shadcn/ui's `cn`.
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
