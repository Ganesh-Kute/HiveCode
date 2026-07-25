// StreakBoard Frontend - Fetches and displays habits from backend API

const API_BASE = '/api/habits';

const habitsUl = document.getElementById('habits-ul');
const emptyState = document.getElementById('empty-state');
const habitForm = document.getElementById('habit-form');
const habitInput = document.getElementById('habit-input');

async function fetchHabits() {
  try {
    const response = await fetch(API_BASE);
    if (!response.ok) throw new Error('Failed to fetch habits');
    const data = await response.json();
    return data.habits || [];
  } catch (err) {
    console.error('Error fetching habits:', err);
    return [];
  }
}

function renderHabits(habits) {
  habitsUl.innerHTML = '';
  if (habits.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  habits.forEach(habit => {
    const li = document.createElement('li');
    li.className = 'habit-item';
    li.dataset.id = habit.id;
    li.innerHTML = `
      <div class="habit-info">
        <span class="habit-name">${escapeHtml(habit.name)}</span>
        <span class="habit-streak">🔥 ${habit.streak} day${habit.streak !== 1 ? 's' : ''}</span>
      </div>
      <div class="habit-actions">
        <button class="check-btn" ${habit.lastChecked === new Date().toISOString().split('T')[0] ? 'disabled' : ''}>
          ${habit.lastChecked === new Date().toISOString().split('T')[0] ? '✓ Done' : 'Check In'}
        </button>
        <button class="delete-btn">Delete</button>
      </div>
    `;
    habitsUl.appendChild(li);

    // Add event listeners for this habit
    const checkBtn = li.querySelector('.check-btn');
    const deleteBtn = li.querySelector('.delete-btn');

    checkBtn.addEventListener('click', () => checkHabit(habit.id));
    deleteBtn.addEventListener('click', () => deleteHabit(habit.id));
  });
}

async function addHabit(name) {
  try {
    const response = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!response.ok) throw new Error('Failed to add habit');
    const habit = await response.json();
    return habit;
  } catch (err) {
    console.error('Error adding habit:', err);
    alert('Failed to add habit');
    return null;
  }
}

async function checkHabit(id) {
  try {
    const response = await fetch(`${API_BASE}/${id}/check`, { method: 'POST' });
    if (!response.ok) throw new Error('Failed to check habit');
    const habit = await response.json();
    return habit;
  } catch (err) {
    console.error('Error checking habit:', err);
    alert('Failed to check habit');
    return null;
  }
}

async function deleteHabit(id) {
  if (!confirm('Delete this habit?')) return;
  try {
    const response = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete habit');
    return true;
  } catch (err) {
    console.error('Error deleting habit:', err);
    alert('Failed to delete habit');
    return false;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function loadAndRender() {
  const habits = await fetchHabits();
  renderHabits(habits);
}

// Event listeners
habitForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = habitInput.value.trim();
  if (!name) return;
  await addHabit(name);
  habitInput.value = '';
  await loadAndRender();
});

// Initial load
loadAndRender();

// Auto-refresh every 30 seconds
setInterval(loadAndRender, 30000);// StreakBoard Frontend - Fetches and displays habits from backend API
