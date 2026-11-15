import { getBranding } from '../../branding';

interface ClaudiaAvatarProps {
  isThinking?: boolean;
  className?: string;
}

export function ClaudiaAvatar({ isThinking = false, className = '' }: ClaudiaAvatarProps) {
  const { avatarUrl } = getBranding();
  return (
    <div
      className={[
        'flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-[5px] text-[11px] font-bold text-white',
        avatarUrl ? '' : 'bg-accent',
        isThinking ? 'animate-claudia-thinking' : '',
        className,
      ].join(' ')}
    >
      {avatarUrl ? <img src={avatarUrl} alt="" className="h-full w-full object-contain" draggable={false} /> : 'C'}
    </div>
  );
}
