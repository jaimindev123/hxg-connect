import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { tenantApi } from '../lib/api';
import { budget, Empty, ErrorState, inr, Loading, useLoad, useToast, when } from '../lib/ui';
import { LostReason, usePipeline } from './Leads';

export default function Pipeline() {
  const pipes = usePipeline();
  const pipeline = pipes.data?.[0];
  if (pipes.error) return <ErrorState error={pipes.error} retry={pipes.reload} />;
  if (!pipeline) return <Loading />;
  return <Board pipelineId={pipeline.id} name={pipeline.name} />;
}

function Board({ pipelineId, name }: { pipelineId: string; name: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const board = useLoad<any[]>(() => tenantApi.get(`/pipelines/${pipelineId}/board`), [pipelineId]);
  const [drag, setDrag] = useState<{ card: any; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pendingLost, setPendingLost] = useState<{ card: any; from: string; to: any } | null>(null);

  if (board.error) return <ErrorState error={board.error} retry={board.reload} />;
  if (!board.data) return <Loading />;
  const cols = board.data;
  const total = cols.reduce((n, c) => n + c.count, 0);

  function shift(card: any, from: string, to: string) {
    board.setData(cs => cs!.map(c =>
      c.id === from ? { ...c, count: c.count - 1, value: Number(c.value) - Number(card.budget_max ?? 0), cards: c.cards.filter((x: any) => x.id !== card.id) }
      : c.id === to ? { ...c, count: c.count + 1, value: Number(c.value) + Number(card.budget_max ?? 0), cards: [{ ...card, stage_id: to }, ...c.cards] }
      : c));
  }

  async function commit(card: any, from: string, to: any, reason?: string) {
    shift(card, from, to.id);                    // optimistic
    try {
      await tenantApi.post(`/leads/${card.id}/stage`, { stage_id: to.id, note: reason });
      toast(`${card.name} moved to ${to.name}`);
    } catch (e: any) {
      shift(card, to.id, from);                  // roll back
      toast(e.message, true);
    }
  }

  function drop(to: any) {
    setOver(null);
    if (!drag || drag.from === to.id) return;
    if (to.is_lost) setPendingLost({ card: drag.card, from: drag.from, to });
    else commit(drag.card, drag.from, to);
    setDrag(null);
  }

  return (
    <>
      <div className="page-head"><div className="grow"><h1>Pipeline</h1><p>{name}, {total} lead{total === 1 ? '' : 's'}. Drag a card to move it.</p></div></div>
      {total === 0 ? <div className="panel"><Empty title="The board is empty">Leads appear in New Lead as soon as they're added.</Empty></div> : (
        <div className="board">
          {cols.map(c => (
            <div key={c.id} className={`col ${over === c.id ? 'over' : ''}`}
              onDragOver={e => { e.preventDefault(); setOver(c.id); }}
              onDragLeave={() => setOver(o => (o === c.id ? null : o))}
              onDrop={() => drop(c)}>
              <div className="col-head">
                <div className="t">{c.name}<span className="c">{c.count}</span></div>
                {Number(c.value) > 0 && <div className="money">{inr(c.value)}</div>}
              </div>
              {c.cards.map((card: any) => {
                const late = card.next_due && new Date(card.next_due) < new Date();
                return (
                  <div key={card.id} className={`card ${late ? 'urgent' : ''} ${drag?.card.id === card.id ? 'dragging' : ''}`} draggable
                    onDragStart={() => setDrag({ card, from: c.id })} onDragEnd={() => { setDrag(null); setOver(null); }}
                    onClick={() => nav(`/leads/${card.id}`)} role="button" tabIndex={0}
                    onKeyDown={e => e.key === 'Enter' && nav(`/leads/${card.id}`)}>
                    <div className="n">{card.name}</div>
                    <div className="m"><span className="money">{budget(card.budget_min, card.budget_max)}</span><span className="grow" />{card.owner}</div>
                    <div className="m">
                      {card.next_due ? <span className={late ? 'overdue-text' : ''}>{late ? 'Overdue' : 'Next'} {when(card.next_due)}</span>
                        : !c.is_won && !c.is_lost ? <span className="overdue-text">No next step</span> : null}
                    </div>
                  </div>
                );
              })}
              {c.count > c.cards.length && <div className="small muted" style={{ padding: '4px 6px' }}>and {c.count - c.cards.length} more</div>}
            </div>
          ))}
        </div>
      )}
      {pendingLost && <LostReason onClose={() => setPendingLost(null)}
        onConfirm={r => { commit(pendingLost.card, pendingLost.from, pendingLost.to, r); setPendingLost(null); }} />}
    </>
  );
}
