// shadcn/ui's input, textarea and label, with the app's colors.
import { Label as LabelPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from './cn'

const field =
  'w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(field, 'h-9', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'min-h-16 resize-none', className)} {...props} />
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn('flex flex-col gap-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />
}

/** A label above its control, as the forms of the site lay them out. */
export function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <Label className={className}>
      <span>{label}</span>
      {children}
    </Label>
  )
}
