// shadcn/ui's card and badge.
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from './cn'

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-xl border bg-card text-card-foreground', className)} {...props} />
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 px-4 pt-4', className)} {...props} />
}

export function CardTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('font-semibold leading-none', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-4', className)} {...props} />
}

const badgeVariants = cva('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary/15 text-primary',
      secondary: 'border-transparent bg-secondary text-muted-foreground',
      outline: 'text-muted-foreground',
      success: 'border-transparent bg-success/15 text-success',
      warning: 'border-transparent bg-warning/15 text-warning',
      destructive: 'border-transparent bg-destructive/15 text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
})

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
