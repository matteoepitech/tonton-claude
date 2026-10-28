// shadcn/ui's card and badge.
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from './cn'

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('raised rounded-lg border bg-card text-card-foreground', className)} {...props} />
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
      default: 'border-primary/30 text-primary',
      secondary: 'text-muted-foreground',
      outline: 'text-muted-foreground',
      success: 'border-success/30 text-success',
      warning: 'border-warning/30 text-warning',
      destructive: 'border-destructive/30 text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
})

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
