import React, { useState } from 'react'
import { describeError, downloadEvidence, pollJob, startEvidencePack } from '../../api/sccmApi'
import { Spinner, downloadBlob } from './ui'

/* Builds and downloads the evidence pack (zip) of a deployment: reports, job log,
   audit entries, AD list and the run's files from the jumphost, with SHA-256 hashes. */
export default function EvidenceButton({ jobId, className = 'wpx-btn wpx-btn-soft', small = false }) {
  const [state, setState] = useState({ busy: false, error: null, note: null })
  const run = async () => {
    setState({ busy: true, error: null, note: null })
    try {
      const job = await pollJob(await startEvidencePack(jobId))
      const { blob, name } = await downloadEvidence(job.job_id)
      downloadBlob(name, blob)
      const note = job.status !== 'SUCCEEDED'
        ? 'Downloaded without the jumphost files (they could not be collected; see README.txt in the pack).'
        : job.result?.note || null
      setState({ busy: false, error: null, note })
    } catch (e) {
      setState({ busy: false, error: describeError(e), note: null })
    }
  }
  return (
    <span className="wpx-evidence">
      <button type="button" className={`${className}${small ? ' wpx-btn-sm' : ''}`} onClick={run} disabled={state.busy} title="Reports, job log, audit entries, AD list and the jumphost files (transcript, summary, validation) in one zip">
        {state.busy ? <Spinner label="Collecting evidence…" /> : <><i className="fa-solid fa-box-archive" /> Evidence pack</>}
      </button>
      {state.error && <span className="wpx-evidence-msg wpx-tone-bad">{state.error}</span>}
      {state.note && <span className="wpx-evidence-msg wpx-tone-warn">{state.note}</span>}
    </span>
  )
}
