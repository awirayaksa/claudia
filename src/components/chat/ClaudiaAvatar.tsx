interface ClaudiaAvatarProps {
  isThinking?: boolean;
  className?: string;
}

export function ClaudiaAvatar({ isThinking = false, className = '' }: ClaudiaAvatarProps) {
  return (
    <div
      className={[
        'flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-[5px] bg-accent text-[11px] font-bold text-white',
        isThinking ? 'animate-claudia-thinking' : '',
        className,
      ].join(' ')}
    >
      C
    </div>
  );
}
