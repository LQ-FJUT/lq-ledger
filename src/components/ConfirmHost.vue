<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { confirmState, resolveConfirm } from '@/services/confirm';

const cancelButton = ref<HTMLButtonElement | null>(null);
watch(() => confirmState.open, (open) => { if (open) void nextTick(() => cancelButton.value?.focus()); });
</script>

<template>
  <Teleport to="body">
    <div v-if="confirmState.open" class="dialog-backdrop" @click.self="resolveConfirm(false)" @keydown.esc.prevent="resolveConfirm(false)">
      <section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <h2 id="confirm-title">{{ confirmState.title }}</h2>
        <p id="confirm-message">{{ confirmState.message }}</p>
        <div class="dialog-actions"><button ref="cancelButton" class="secondary-button" type="button" @click="resolveConfirm(false)">取消</button><button :class="confirmState.danger ? 'danger-button' : 'primary-button'" type="button" @click="resolveConfirm(true)">{{ confirmState.confirmLabel }}</button></div>
      </section>
    </div>
  </Teleport>
</template>
