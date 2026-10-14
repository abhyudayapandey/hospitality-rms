import type { RequestActionData } from '@/lib/request-actions';
import { ReassignTask, ReceiveSent } from '@/app/(app)/tasks/[id]/receive-sent';
import { SendTask } from '@/app/(app)/tasks/[id]/send-task';
import { TransferStepForm } from './transfer-step-form';
import { SenderTools } from './sender-tools';

/**
 * Every button the viewer may use on a request between stores (ADR 147), the same wherever the
 * request is opened: its own page, or the page of the ask it was made for. Their own send or
 * receive task is done here, not on a page of its own.
 */
export function RequestActions({ data }: { data: RequestActionData }) {
  const { task } = data;
  return (
    <>
      {task?.kind === 'send' ? (
        <SendTask task={task.id} lines={task.sendLines} canWork={task.canWork} />
      ) : task?.kind === 'receive' && task.canWork ? (
        <ReceiveSent task={task.id} lines={task.sentLines} department={task.department} />
      ) : (
        <TransferStepForm
          transfer={data.transfer}
          requestId={data.wfRequest}
          mode={data.mode}
          lines={data.lines}
          gm={data.gm}
        />
      )}
      {!task && data.mode === 'dispatch' && (
        <SenderTools transfer={data.transfer} people={data.sendPeople} givenTo={data.givenTo} />
      )}
      {task?.canHandOn && <ReassignTask task={task.id} people={task.handOn} current={null} />}
    </>
  );
}
