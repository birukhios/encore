import type { HTMLAttributes } from 'react';

export function Badge({ className = '', ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`tw:inline-flex tw:items-center tw:rounded-md tw:px-2 tw:py-0.5 tw:text-[11px] tw:font-semibold ${className}`} {...props} />;
}
