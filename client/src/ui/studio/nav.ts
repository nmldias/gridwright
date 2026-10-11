// Opening the guided import studio from anywhere (menus, the start card, the lineage dialog).
import { useStore } from '../../state/store';

export type StudioTab = 'prepare' | 'results' | 'related' | 'audit';
export function openStudio(dataset?: string, tab?: StudioTab, run?: string) {
  useStore.setState({ studio: { dataset, tab, run } });
}
export const closeStudio = () => useStore.setState({ studio: null });
