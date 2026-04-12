import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import type { Skill, SkillWritePayload } from '../../types/skill.types';

interface SkillState {
  skills: Skill[];
  isLoading: boolean;
  error: string | null;
  selectedSkillId: string | null;
}

const initialState: SkillState = {
  skills: [],
  isLoading: false,
  error: null,
  selectedSkillId: null,
};

// ─── Thunks ────────────────────────────────────────────────────────────────────

export const loadSkills = createAsyncThunk('skills/load', async (_, { rejectWithValue }) => {
  try {
    const result = await window.electron.skills.list();
    if (!result.success) return rejectWithValue(result.error ?? 'Failed to load skills');
    return result.skills as Skill[];
  } catch (err) {
    return rejectWithValue(err instanceof Error ? err.message : 'Failed to load skills');
  }
});

export const createSkill = createAsyncThunk(
  'skills/create',
  async (payload: SkillWritePayload, { rejectWithValue }) => {
    try {
      const result = await window.electron.skills.create(payload);
      if (!result.success) return rejectWithValue(result.error ?? 'Failed to create skill');
      return result.skill as Skill;
    } catch (err) {
      return rejectWithValue(err instanceof Error ? err.message : 'Failed to create skill');
    }
  }
);

export const updateSkill = createAsyncThunk(
  'skills/update',
  async (payload: SkillWritePayload, { rejectWithValue }) => {
    try {
      const result = await window.electron.skills.update(payload);
      if (!result.success) return rejectWithValue(result.error ?? 'Failed to update skill');
      return result.skill as Skill;
    } catch (err) {
      return rejectWithValue(err instanceof Error ? err.message : 'Failed to update skill');
    }
  }
);

export const deleteSkill = createAsyncThunk(
  'skills/delete',
  async (id: string, { rejectWithValue }) => {
    try {
      const result = await window.electron.skills.delete(id);
      if (!result.success) return rejectWithValue(result.error ?? 'Failed to delete skill');
      return id;
    } catch (err) {
      return rejectWithValue(err instanceof Error ? err.message : 'Failed to delete skill');
    }
  }
);

// ─── Slice ─────────────────────────────────────────────────────────────────────

const skillSlice = createSlice({
  name: 'skills',
  initialState,
  reducers: {
    /** Replace the full skills list — used by the file-watcher push event */
    setSkills: (state, action: PayloadAction<Skill[]>) => {
      state.skills = action.payload;
    },
    setSelectedSkill: (state, action: PayloadAction<string | null>) => {
      state.selectedSkillId = action.payload;
    },
    clearSkillError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    // loadSkills
    builder
      .addCase(loadSkills.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadSkills.fulfilled, (state, action) => {
        state.isLoading = false;
        state.skills = action.payload;
      })
      .addCase(loadSkills.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      });

    // createSkill
    builder
      .addCase(createSkill.pending, (state) => { state.error = null; })
      .addCase(createSkill.fulfilled, (state, action) => {
        // Replace or append
        const idx = state.skills.findIndex((s) => s.id === action.payload.id);
        if (idx !== -1) {
          state.skills[idx] = action.payload;
        } else {
          state.skills.push(action.payload);
        }
      })
      .addCase(createSkill.rejected, (state, action) => {
        state.error = action.payload as string;
      });

    // updateSkill
    builder
      .addCase(updateSkill.pending, (state) => { state.error = null; })
      .addCase(updateSkill.fulfilled, (state, action) => {
        const idx = state.skills.findIndex((s) => s.id === action.payload.id);
        if (idx !== -1) state.skills[idx] = action.payload;
      })
      .addCase(updateSkill.rejected, (state, action) => {
        state.error = action.payload as string;
      });

    // deleteSkill
    builder
      .addCase(deleteSkill.pending, (state) => { state.error = null; })
      .addCase(deleteSkill.fulfilled, (state, action) => {
        state.skills = state.skills.filter((s) => s.id !== action.payload);
        if (state.selectedSkillId === action.payload) state.selectedSkillId = null;
      })
      .addCase(deleteSkill.rejected, (state, action) => {
        state.error = action.payload as string;
      });
  },
});

export const { setSkills, setSelectedSkill, clearSkillError } = skillSlice.actions;
export default skillSlice.reducer;
