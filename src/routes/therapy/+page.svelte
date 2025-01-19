<script lang="ts">
	import { errorAsString, responseErrorAsString } from '$lib/util/error';
	import { parseEventSourceStream } from '$lib/util/eventsource-parser';

	let userInput = 'arm hurts after tennis';
	let generating = false;
	let output: string[] = [];
	let error: string | undefined;
	let onCancel: () => void = () => {};
	async function onRun() {
		try {
			generating = true;
			output = [];
			error = undefined;
			const abortController = new AbortController();
			onCancel = () => abortController.abort();
			const resp = await fetch('./therapy', {
				method: 'POST',
				signal: abortController.signal,
				body: JSON.stringify({ userInput })
			});
			if (!resp.ok || !resp.body) {
				throw Error(`Server failure: ${await responseErrorAsString(resp)}`);
			}
			for await (const delta of parseEventSourceStream(resp.body)) {
				if (delta.startsWith('{"text":')) {
					output.push(JSON.parse(delta)['text']);
				} else if (delta.startsWith('{')) {
					output.push(JSON.stringify(JSON.parse(delta), null, 2));
				} else {
					output.push(delta);
				}
				output = output;
			}
		} catch (e) {
			error = errorAsString(e);
		} finally {
			onCancel = () => {};
			generating = false;
		}
	}
</script>

{#if generating}
	<div class="m-4 max-w-sm rounded-xl border-2 border-red-500 p-4 shadow-lg">
		<h1 class="my-2 text-2xl">Generating</h1>
		<div>{userInput}</div>
		<button
			class="mt-4 rounded-lg bg-red-500 px-4 py-2 text-xl font-bold uppercase text-white hover:bg-red-400"
			on:click={onCancel}
		>
			Cancel
		</button>
	</div>
{:else}
	<div class="m-4 max-w-5xl rounded-xl border-2 border-blue-500 p-4 shadow-lg">
		<h1 class="my-2 text-2xl">Therapy Session Generator</h1>
		<!-- svelte-ignore a11y-autofocus -->
		<textarea
			bind:value={userInput}
			rows={4}
			autofocus
			class="query w-full rounded px-3 py-2 text-lg ring-1"
			autocomplete="off"
			disabled={generating}
		>
		</textarea>
		<button
			class="mt-4 rounded-lg bg-blue-500 px-4 py-2 text-xl font-bold uppercase text-white hover:bg-blue-400"
			on:click={onRun}
		>
			Generate
		</button>
	</div>
{/if}
{#if error}
	<div class="m-4 whitespace-pre-wrap border-2 border-red-700 p-4">{error}</div>
{/if}
{#if output.length > 0}
	<div class="m-4 border-2 border-blue-700 p-4">
		{#each output as line}
			<div class="whitespace-pre-wrap">{line}</div>
		{/each}
	</div>
{/if}
