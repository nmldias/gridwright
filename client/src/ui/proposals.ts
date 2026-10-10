import { api, type Proposal } from '../api/client';
import { getState, useStore } from '../state/store';

let loading = 0;

/** Load the open document's proposals into the store (the Review panel and the top bar read them). */
export async function loadProposals(): Promise<void> {
  const fileId = getState().fileId;
  if (!fileId) {
    useStore.setState({ proposals: [] });
    return;
  }
  const n = ++loading;
  try {
    const ps = await api.files.proposals(fileId);
    if (n === loading && getState().fileId === fileId) useStore.setState({ proposals: ps });
  } catch {
    if (n === loading) useStore.setState({ proposals: [] });
  }
}

/** Replace one proposal in the store (after a decision or a refresh). */
export function putProposal(p: Proposal) {
  useStore.setState({ proposals: getState().proposals.map((x) => (x.id === p.id ? p : x)) });
}

export const pendingProposals = () => getState().proposals.filter((p) => p.status === 'pending');
