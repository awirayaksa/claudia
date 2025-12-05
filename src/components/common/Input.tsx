import React from 'react';
import { clsx } from 'clsx';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export function Input({
  label,
  error,
  helperText,
  className,
  id,
  ...props
}: InputProps) {
  const inputId = id || `input-${Math.random().toString(36).substr(2, 9)}`;

  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={inputId}
          className="mb-1.5 block text-sm font-medium text-text-primary"
        >
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={clsx(
          'w-full rounded border px-3 py-2 text-sm transition-colors',
          'bg-background text-text-primary placeholder-text-secondary',
          'focus:outline-none focus:ring-2 focus:ring-accent',
          error
            ? 'border-error focus:ring-error'
            : 'border-border hover:border-accent',
          className
        )}
        {...props}
      />
      {error && <p className="mt-1 text-sm text-error">{error}</p>}
      {helperText && !error && (
        <p className="mt-1 text-sm text-text-secondary">{helperText}</p>
      )}
    </div>
  );
}
