import { useState, useCallback, useRef } from 'react';
import type { Skill } from '../types/skill.types';

export interface SkillMentionResult {
  isOpen: boolean;
  query: string;
  filteredSkills: Skill[];
  activeIndex: number;
  handleChange: (value: string, cursorPos: number) => void;
  handleKeyDown: (
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ) => { consumed: boolean; newValue?: string; newCursorPos?: number };
  selectSkill: (
    skill: Skill,
    value: string,
    cursorPos: number
  ) => { newValue: string; newCursorPos: number };
  close: () => void;
}

export function useSkillMention(skills: Skill[]): SkillMentionResult {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filteredSkills, setFilteredSkills] = useState<Skill[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerIndexRef = useRef<number | null>(null);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setActiveIndex(0);
    setFilteredSkills([]);
    triggerIndexRef.current = null;
  }, []);

  const handleChange = useCallback(
    (value: string, cursorPos: number) => {
      const textBeforeCursor = value.slice(0, cursorPos);

      // Find last `/` before cursor
      const slashIdx = textBeforeCursor.lastIndexOf('/');

      if (slashIdx === -1) {
        if (isOpen) close();
        return;
      }

      // Word boundary check: char before `/` must be start-of-string, space, or newline
      if (slashIdx > 0) {
        const charBefore = value[slashIdx - 1];
        if (charBefore !== ' ' && charBefore !== '\n') {
          if (isOpen) close();
          return;
        }
      }

      const rawQuery = value.slice(slashIdx + 1, cursorPos);

      // If query contains a space, the user has passed the command name into args — close
      if (rawQuery.includes(' ')) {
        if (isOpen) close();
        return;
      }

      const q = rawQuery.toLowerCase();
      const filtered = q
        ? skills.filter(
            (s) => s.id.startsWith(q) || s.name.toLowerCase().includes(q)
          )
        : skills;

      setQuery(rawQuery);
      setFilteredSkills(filtered);
      setActiveIndex(0);
      setIsOpen(true);
      triggerIndexRef.current = slashIdx;
    },
    [skills, isOpen, close]
  );

  const buildReplacement = useCallback(
    (
      skill: Skill,
      value: string,
      cursorPos: number
    ): { newValue: string; newCursorPos: number } => {
      const slashIdx = triggerIndexRef.current ?? 0;
      const before = value.slice(0, slashIdx);
      const after = value.slice(cursorPos);
      // Insert command with trailing space so user can type args immediately
      const token = `/${skill.id} `;
      const newValue = `${before}${token}${after}`;
      const newCursorPos = slashIdx + token.length;
      return { newValue, newCursorPos };
    },
    []
  );

  const selectSkill = useCallback(
    (skill: Skill, value: string, cursorPos: number) => {
      const result = buildReplacement(skill, value, cursorPos);
      close();
      return result;
    },
    [buildReplacement, close]
  );

  const handleKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLTextAreaElement>
    ): { consumed: boolean; newValue?: string; newCursorPos?: number } => {
      if (!isOpen) return { consumed: false };

      if (e.key === 'ArrowDown') {
        setActiveIndex((prev) => (prev + 1) % Math.max(filteredSkills.length, 1));
        return { consumed: true };
      }

      if (e.key === 'ArrowUp') {
        setActiveIndex((prev) =>
          prev === 0 ? Math.max(filteredSkills.length - 1, 0) : prev - 1
        );
        return { consumed: true };
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        const skill = filteredSkills[activeIndex];
        if (!skill) return { consumed: true };
        const textarea = e.currentTarget;
        const cursorPos = textarea.selectionStart ?? textarea.value.length;
        const { newValue, newCursorPos } = buildReplacement(skill, textarea.value, cursorPos);
        close();
        return { consumed: true, newValue, newCursorPos };
      }

      if (e.key === 'Escape') {
        close();
        return { consumed: true };
      }

      return { consumed: false };
    },
    [isOpen, filteredSkills, activeIndex, buildReplacement, close]
  );

  return {
    isOpen,
    query,
    filteredSkills,
    activeIndex,
    handleChange,
    handleKeyDown,
    selectSkill,
    close,
  };
}
